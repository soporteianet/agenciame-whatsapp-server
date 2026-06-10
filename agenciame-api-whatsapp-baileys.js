// pages/api/whatsapp-baileys.js
// Recibe mensajes de WhatsApp desde el servidor Baileys,
// procesa con IA y devuelve la respuesta

import { db as adminDb } from '../../lib/firebaseAdmin';
import { FieldValue } from 'firebase-admin/firestore';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SERVER_SECRET = process.env.SERVER_SECRET || 'agenciame2026secret';

// Mantener historial de conversaciones en memoria (se pierde al reiniciar)
// Para produccion seria mejor guardarlo en Firestore
const historiales = new Map();

export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') return res.status(405).end();

  // Verificar secreto
  const secret = req.headers['x-server-secret'];
  if (secret !== SERVER_SECRET) return res.status(401).json({ error: 'No autorizado' });

  const { empresaId, numeroCliente, texto, msgId } = req.body;
  if (!empresaId || !numeroCliente || !texto) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    // 1. Obtener datos de la empresa
    const empresaSnap = await adminDb.collection('empresas').doc(empresaId).get();
    if (!empresaSnap.exists) return res.status(404).json({ error: 'Empresa no encontrada' });
    const empresa = empresaSnap.data();

    // 2. Verificar que WhatsApp esté activo para esta empresa
    if (!empresa.whatsapp?.activo) {
      return res.json({ respuesta: null }); // no responder si no está activado
    }

    // 3. Verificar trial activo
    if (empresa.plan === 'emprendedor' && empresa.trialHasta) {
      const hasta = empresa.trialHasta?.toDate ? empresa.trialHasta.toDate() : new Date(empresa.trialHasta);
      if (new Date() > hasta) {
        return res.json({
          respuesta: `Hola! El período de prueba de ${empresa.nombreEmpresa} ha vencido. Para continuar usando el servicio, contacta al administrador.`,
        });
      }
    }

    // 4. Obtener base de conocimiento del agente
    const conocimientoSnap = await adminDb
      .collection('empresas').doc(empresaId)
      .collection('config').doc('conocimiento')
      .get();
    const conocimiento = conocimientoSnap.exists ? conocimientoSnap.data() : null;

    // 5. Buscar o crear contacto en CRM
    const contactosRef = adminDb.collection('empresas').doc(empresaId).collection('contactos');
    const contactoQuery = await contactosRef.where('telefono', '==', numeroCliente).limit(1).get();

    let contactoId;
    let nombreCliente = numeroCliente;

    if (contactoQuery.empty) {
      // Crear nuevo contacto
      const nuevoContacto = await contactosRef.add({
        telefono: numeroCliente,
        nombre: numeroCliente,
        canal: 'whatsapp',
        fuente: 'whatsapp-baileys',
        estado: 'nuevo',
        creadoEn: FieldValue.serverTimestamp(),
      });
      contactoId = nuevoContacto.id;
    } else {
      const doc = contactoQuery.docs[0];
      contactoId = doc.id;
      nombreCliente = doc.data().nombre || numeroCliente;
    }

    // 6. Armar historial de conversacion (ultimos 8 mensajes)
    const historialKey = `${empresaId}_${numeroCliente}`;
    if (!historiales.has(historialKey)) historiales.set(historialKey, []);
    const historial = historiales.get(historialKey);

    // Agregar mensaje del cliente al historial
    historial.push({ role: 'user', content: texto });
    // Mantener solo los ultimos 8 mensajes
    if (historial.length > 8) historial.splice(0, historial.length - 8);

    // 7. Construir system prompt con datos de la empresa
    let systemPrompt = `Eres el asistente virtual de ${empresa.nombreEmpresa}, un negocio de ${empresa.industria || 'servicios'} en ${empresa.ciudad || 'Colombia'}.

Estas atendiendo por WhatsApp al cliente ${nombreCliente} (numero: ${numeroCliente}).

INSTRUCCIONES:
- Responde de forma amigable, profesional y concisa (maximo 3 parrafos cortos)
- Usa emojis moderadamente para que sea mas agradable
- Si el cliente quiere agendar, pide nombre, servicio y horario preferido
- Si preguntan por precios, da la informacion exacta
- No inventes informacion que no este en la base de conocimiento
- El idioma es espanol colombiano`;

    if (conocimiento) {
      if (conocimiento.servicios?.length > 0) {
        const svcs = conocimiento.servicios
          .filter(s => s.nombre)
          .map(s => `- ${s.nombre}: $${s.precio || 'consultar'} COP${s.duracion ? ` (${s.duracion} min)` : ''}${s.descripcion ? ` - ${s.descripcion}` : ''}`)
          .join('\n');
        systemPrompt += `\n\nSERVICIOS Y PRECIOS:\n${svcs}`;
      }

      if (conocimiento.info) {
        const info = conocimiento.info;
        if (info.direccion)           systemPrompt += `\n\nDIRECCION: ${info.direccion}, ${info.ciudad || empresa.ciudad}`;
        if (info.telefono)            systemPrompt += `\nTELEFONO: ${info.telefono}`;
        if (info.descripcionNegocio)  systemPrompt += `\n\nDESCRIPCION: ${info.descripcionNegocio}`;
        if (info.politicaCancelacion) systemPrompt += `\nPOLITICA: ${info.politicaCancelacion}`;
        if (info.formasPago?.length)  systemPrompt += `\nPAGOS: ${info.formasPago.join(', ')}`;
      }

      if (conocimiento.horarios) {
        const hDias = Object.entries(conocimiento.horarios)
          .filter(([, v]) => v.activo)
          .map(([dia, v]) => `${dia}: ${v.desde} - ${v.hasta}`)
          .join(', ');
        if (hDias) systemPrompt += `\n\nHORARIOS: ${hDias}`;
      }

      if (conocimiento.info?.preguntasFrecuentes?.length > 0) {
        const faqs = conocimiento.info.preguntasFrecuentes
          .filter(f => f.pregunta)
          .map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`)
          .join('\n');
        systemPrompt += `\n\nPREGUNTAS FRECUENTES:\n${faqs}`;
      }
    }

    // 8. Llamar a OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        ...historial,
      ],
    });

    const respuesta = completion.choices[0]?.message?.content || '';

    // Agregar respuesta al historial
    historial.push({ role: 'assistant', content: respuesta });

    // 9. Guardar conversacion en Firestore
    const convRef = adminDb
      .collection('empresas').doc(empresaId)
      .collection('conversaciones');

    const convKey = `wa_${numeroCliente}`;
    await convRef.doc(convKey).set({
      nombreCliente,
      numeroCliente,
      canal: 'whatsapp',
      ultimoTexto: texto,
      ultimoMensaje: FieldValue.serverTimestamp(),
      contactoId,
    }, { merge: true });

    // Guardar mensajes individuales
    await convRef.doc(convKey).collection('mensajes').add({
      rol: 'cliente',
      texto,
      creadoEn: FieldValue.serverTimestamp(),
    });
    await convRef.doc(convKey).collection('mensajes').add({
      rol: 'agente',
      texto: respuesta,
      creadoEn: FieldValue.serverTimestamp(),
    });

    // 10. Devolver respuesta al servidor Baileys
    return res.json({ respuesta });

  } catch (err) {
    console.error('Error whatsapp-baileys:', err);
    return res.status(500).json({ error: err.message });
  }
}
