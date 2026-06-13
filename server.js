// server.js — agencIAme WhatsApp Multi-Empresa Server
// v4: + recordatorios de citas (Plan Pro) + seguimiento post-servicio (Estandar/Pro)
//     con limites de seguridad: horario, delays aleatorios y tope diario por empresa

import express from 'express';
import cors from 'cors';
import { createRequire } from 'module';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import axios from 'axios';
import qrcode from 'qrcode';
import NodeCache from 'node-cache';
import pino from 'pino';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const PORT          = process.env.PORT || 3001;
const SERVER_SECRET = process.env.SERVER_SECRET || 'agenciame2026secreto_nexoia';
const AGENCIAME_API = process.env.AGENCIAME_API_URL || 'https://agenciame.com';

const sesiones = new Map();
const msgCache = new NodeCache({ stdTTL: 300 });
const logger   = pino({ level: 'warn' });

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const authMiddleware = (req, res, next) => {
  const token = req.headers['x-server-secret'] || req.query.secret;
  if (token !== SERVER_SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
};

async function getBaileys() {
  return import('@whiskeysockets/baileys');
}

async function saveCredsToFirestore(empresaId, creds) {
  try {
    await db.collection('wa_sessions').doc(empresaId).set(
      { creds: JSON.stringify(creds), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) { console.error(`[${empresaId}] saveCredsToFirestore:`, e.message); }
}

async function loadCredsFromFirestore(empresaId) {
  try {
    const snap = await db.collection('wa_sessions').doc(empresaId).get();
    if (!snap.exists) return null;
    const raw = snap.data().creds;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function deleteSessionFromFirestore(empresaId) {
  try { await db.collection('wa_sessions').doc(empresaId).delete(); } catch {}
}

// ── Enviar imagen por WhatsApp desde URL ──────────────────────
async function enviarImagen(sock, jid, url, caption = '') {
  try {
    // Descargar imagen como buffer
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    const buffer = Buffer.from(resp.data);
    const mimetype = resp.headers['content-type'] || 'image/jpeg';

    await sock.sendMessage(jid, {
      image: buffer,
      mimetype,
      caption: caption || undefined,
    });
    return true;
  } catch (e) {
    console.error(`Error enviando imagen ${url}:`, e.message);
    return false;
  }
}

async function crearSocket(empresaId, usePairingCode = false) {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
  } = await getBaileys();

  const sessionDir = path.join('/tmp', 'wa_sessions', empresaId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const savedCreds = await loadCredsFromFirestore(empresaId);
  if (savedCreds) {
    try {
      fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(savedCreds));
      console.log(`[${empresaId}] Creds restauradas desde Firestore`);
    } catch {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    printQRInTerminal: !usePairingCode,
    ...(usePairingCode ? { browser: ['agencIAme', 'Chrome', '120.0.0'] } : {}),
  });

  const sesionData = { sock, status: 'connecting', qr: null, qrBase64: null, empresaId, numero: null, connectedAt: null, usePairingCode };
  sesiones.set(empresaId, sesionData);

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    try {
      const credsFile = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsFile)) {
        const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        await saveCredsToFirestore(empresaId, credsData);
      }
    } catch {}
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !usePairingCode) {
      const qrBase64 = await qrcode.toDataURL(qr);
      sesionData.qr = qr; sesionData.qrBase64 = qrBase64; sesionData.status = 'qr_ready';
      await db.collection('empresas').doc(empresaId).set(
        { whatsapp: { status: 'qr_ready', qrBase64, updatedAt: FieldValue.serverTimestamp() } },
        { merge: true }
      ).catch(() => {});
      console.log(`[${empresaId}] QR listo`);
    }

    if (connection === 'open') {
      sesionData.status = 'connected';
      sesionData.qr = null; sesionData.qrBase64 = null;
      sesionData.connectedAt = Date.now();
      const numero = sock.user?.id?.split(':')[0] || '';
      sesionData.numero = numero;
      await db.collection('empresas').doc(empresaId).set(
        { whatsapp: { status: 'connected', activo: true, numero, qrBase64: null, connectedAt: FieldValue.serverTimestamp() } },
        { merge: true }
      ).catch(() => {});
      console.log(`[${empresaId}] Conectado - ${numero}`);
    }

    if (connection === 'close') {
      const code   = lastDisconnect?.error?.output?.statusCode;
      const logout = code === DisconnectReason.loggedOut;
      sesionData.status = logout ? 'disconnected' : 'reconnecting';
      if (logout) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        await deleteSessionFromFirestore(empresaId);
        sesiones.delete(empresaId);
        await db.collection('empresas').doc(empresaId).set(
          { whatsapp: { status: 'disconnected', activo: false, numero: null } }, { merge: true }
        ).catch(() => {});
        console.log(`[${empresaId}] Logout`);
      } else {
        console.log(`[${empresaId}] Desconectado (${code}), reconectando en 5s...`);
        setTimeout(() => crearSocket(empresaId, false), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const from = msg.key.remoteJid;
      if (!from || from.endsWith('@g.us') || from.includes('broadcast')) continue;
      const msgTimestamp = msg.messageTimestamp;
      if (msgTimestamp && Date.now() / 1000 - msgTimestamp > 60) continue;
      if (sesionData.connectedAt && msgTimestamp * 1000 < sesionData.connectedAt) continue;
      const msgId = msg.key.id;
      if (!msgId || msgCache.get(msgId)) continue;
      msgCache.set(msgId, true);
      const texto =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || '';
      if (!texto.trim()) continue;
      const numeroCliente = from.replace('@s.whatsapp.net', '');
      console.log(`[${empresaId}] MSG de ${numeroCliente}: ${texto.substring(0, 80)}`);

      try {
        const resp = await axios.post(
          `${AGENCIAME_API}/api/whatsapp-baileys`,
          { empresaId, numeroCliente, texto, msgId },
          { headers: { 'x-server-secret': SERVER_SECRET }, timeout: 25000 }
        );

        const respuesta = resp.data?.respuesta;
        const imagenes  = resp.data?.imagenes || []; // [{url, caption}]

        // 1. Enviar texto primero
        if (respuesta?.trim()) {
          await sock.sendMessage(from, { text: respuesta });
        }

        // 2. Enviar imagenes una por una con pausa entre ellas
        if (imagenes.length > 0) {
          console.log(`[${empresaId}] Enviando ${imagenes.length} imagenes a ${numeroCliente}`);
          for (const img of imagenes) {
            if (!img?.url) continue;
            await enviarImagen(sock, from, img.url, img.caption || '');
            // Pausa de 500ms entre imagenes para no saturar
            await new Promise(r => setTimeout(r, 500));
          }
        }

      } catch (err) {
        if (err.response) console.error(`[${empresaId}] Error API ${err.response.status}:`, JSON.stringify(err.response.data));
        else console.error(`[${empresaId}] Error red: ${err.message}`);
      }
    }
  });

  return sesionData;
}

async function iniciarSesion(empresaId) {
  const existente = sesiones.get(empresaId);
  if (existente && existente.status === 'connected') return { status: 'already_connected' };
  await crearSocket(empresaId, false);
  return { status: 'starting' };
}

async function restaurarSesiones() {
  try {
    const snap = await db.collection('wa_sessions').get();
    console.log(`Restaurando ${snap.size} sesiones desde Firestore...`);
    for (const docSnap of snap.docs) {
      try {
        await iniciarSesion(docSnap.id);
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) { console.error(`Error restaurando ${docSnap.id}:`, e.message); }
    }
  } catch (e) { console.error('restaurarSesiones:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  RECORDATORIOS DE CITAS (Plan Pro) + SEGUIMIENTO POST-SERVICIO
//  (Plan Estandar y Pro) — con limites de seguridad anti-bloqueo
// ══════════════════════════════════════════════════════════════

const ZONA_COL          = 'America/Bogota';
const HORA_INICIO       = 8;   // 8am
const HORA_FIN          = 20;  // 8pm
const TOPE_DIARIO_AUTO  = 60;  // max mensajes automaticos por empresa por dia
const DELAY_MIN_MS      = 4000;
const DELAY_MAX_MS      = 12000;

function horaColombia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: ZONA_COL }));
}

function dentroHorarioPermitido() {
  const h = horaColombia().getHours();
  return h >= HORA_INICIO && h < HORA_FIN;
}

function fechaColombiaKey() {
  const d = horaColombia();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Devuelve true si la empresa todavia tiene cupo hoy, e incrementa el contador
async function puedeEnviarHoy(empresaId, max = TOPE_DIARIO_AUTO) {
  try {
    const fecha = fechaColombiaKey();
    const ref   = db.collection('empresas').doc(empresaId).collection('contadores').doc(fecha);
    const snap  = await ref.get();
    const actual = snap.exists ? (snap.data().enviosAutomaticos || 0) : 0;
    if (actual >= max) return false;
    await ref.set({ enviosAutomaticos: FieldValue.increment(1), fecha, actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  } catch (e) {
    console.error(`[${empresaId}] puedeEnviarHoy:`, e.message);
    return false; // ante la duda, no enviar
  }
}

function delayAleatorio(min = DELAY_MIN_MS, max = DELAY_MAX_MS) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function toDateFlexible(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v._seconds) return new Date(v._seconds * 1000);
  if (v instanceof Date) return v;
  return null;
}

// Envia un mensaje automatico respetando horario + tope diario.
// Devuelve 'ok' | 'fuera_horario' | 'tope_alcanzado' | 'no_conectado' | 'error'
async function enviarMensajeAutomatico(empresaId, numero, texto) {
  const sesion = sesiones.get(empresaId);
  if (!sesion || sesion.status !== 'connected') return 'no_conectado';
  if (!dentroHorarioPermitido()) return 'fuera_horario';
  if (!(await puedeEnviarHoy(empresaId))) return 'tope_alcanzado';
  try {
    const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    await sesion.sock.sendMessage(jid, { text: texto });
    return 'ok';
  } catch (e) {
    console.error(`[${empresaId}] enviarMensajeAutomatico:`, e.message);
    return 'error';
  }
}

// ── Recordatorios de citas — 24h antes (Plan Pro) ─────────────
async function revisarRecordatorios() {
  if (!dentroHorarioPermitido()) return;

  for (const [empresaId, sesion] of sesiones) {
    if (sesion.status !== 'connected') continue;

    try {
      const empSnap = await db.collection('empresas').doc(empresaId).get();
      const emp = empSnap.data();
      if (!emp || emp.planActivo !== true) continue;

      const plan = emp.planWasapbot || emp.plan;
      if (plan !== 'pro') continue; // recordatorios: solo Plan Pro

      const ahora  = Date.now();
      const desde  = ahora + 23 * 3600000; // entre 23h
      const hasta  = ahora + 25 * 3600000; // y 25h desde ahora

      const citasSnap = await db.collection('empresas').doc(empresaId)
        .collection('citas')
        .where('recordatorioEnviado', '==', false)
        .limit(50)
        .get();

      for (const doc of citasSnap.docs) {
        const cita = doc.data();
        if (!['pendiente', 'confirmada'].includes(cita.estado)) continue;
        if (!cita.telefono) continue;

        const fh = toDateFlexible(cita.fechaHora);
        if (!fh) continue;
        const t = fh.getTime();
        if (t < desde || t > hasta) continue;

        const nombre = cita.nombreCliente || 'cliente';
        const texto =
          `👋 Hola ${nombre}, te recordamos tu cita en *${emp.nombreEmpresa}*:\n\n` +
          `📋 ${cita.servicio || 'Servicio'}\n` +
          `📅 ${cita.fecha || ''} a las ${cita.hora || ''}\n\n` +
          `Si necesitas reprogramar o cancelar, respóndenos por este chat. ¡Te esperamos! 😊`;

        const resultado = await enviarMensajeAutomatico(empresaId, cita.telefono, texto);

        if (resultado === 'ok') {
          await doc.ref.update({ recordatorioEnviado: true, recordatorioEnviadoEn: FieldValue.serverTimestamp() });
          console.log(`[${empresaId}] Recordatorio enviado -> ${cita.telefono}`);
          await delayAleatorio();
        } else if (resultado === 'tope_alcanzado' || resultado === 'fuera_horario') {
          // No seguir intentando con esta empresa en esta ronda
          break;
        }
        // 'no_conectado' / 'error' -> simplemente continua con la siguiente cita
      }
    } catch (e) {
      console.error(`[${empresaId}] revisarRecordatorios:`, e.message);
    }
  }
}

// ── Seguimiento post-servicio — 2 a 5h despues (Plan Estandar y Pro) ──
async function revisarSeguimientos() {
  if (!dentroHorarioPermitido()) return;

  for (const [empresaId, sesion] of sesiones) {
    if (sesion.status !== 'connected') continue;

    try {
      const empSnap = await db.collection('empresas').doc(empresaId).get();
      const emp = empSnap.data();
      if (!emp || emp.planActivo !== true) continue;

      const plan = emp.planWasapbot || emp.plan;
      if (!['estandar', 'pro'].includes(plan)) continue; // seguimiento: Estandar y Pro

      const ahora = Date.now();
      const desde = ahora - 5 * 3600000; // completada hace 5h
      const hasta = ahora - 2 * 3600000; // hasta hace 2h

      const citasSnap = await db.collection('empresas').doc(empresaId)
        .collection('citas')
        .where('seguimientoEnviado', '==', false)
        .limit(50)
        .get();

      for (const doc of citasSnap.docs) {
        const cita = doc.data();
        if (cita.estado !== 'completada') continue;
        if (!cita.telefono) continue;

        const ce = toDateFlexible(cita.completadoEn);
        if (!ce) continue;
        const t = ce.getTime();
        if (t < desde || t > hasta) continue;

        const nombre = cita.nombreCliente || 'cliente';
        const texto =
          `Hola ${nombre} 👋 Gracias por visitarnos en *${emp.nombreEmpresa}*.\n\n` +
          `¿Cómo te fue con ${cita.servicio || 'tu servicio'}? Nos encantaría saber tu opinión — ` +
          `y si necesitas algo más, aquí estamos para ayudarte 🙏`;

        const resultado = await enviarMensajeAutomatico(empresaId, cita.telefono, texto);

        if (resultado === 'ok') {
          await doc.ref.update({ seguimientoEnviado: true, seguimientoEnviadoEn: FieldValue.serverTimestamp() });
          console.log(`[${empresaId}] Seguimiento enviado -> ${cita.telefono}`);
          await delayAleatorio();
        } else if (resultado === 'tope_alcanzado' || resultado === 'fuera_horario') {
          break;
        }
      }
    } catch (e) {
      console.error(`[${empresaId}] revisarSeguimientos:`, e.message);
    }
  }
}

async function correrTareasAutomaticas() {
  await revisarRecordatorios().catch(e => console.error('revisarRecordatorios:', e.message));
  await revisarSeguimientos().catch(e => console.error('revisarSeguimientos:', e.message));
}

// ══════════════════════════════════════════════════════════════
//  RUTAS
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  const activas = [...sesiones.values()].filter(s => s.status === 'connected').length;
  res.json({ ok: true, sesionesActivas: activas, sesionesTotales: sesiones.size, uptime: process.uptime(), apiUrl: AGENCIAME_API });
});

app.post('/sesion/iniciar', authMiddleware, async (req, res) => {
  const { empresaId } = req.body;
  if (!empresaId) return res.status(400).json({ error: 'empresaId requerido' });
  try { res.json({ ok: true, ...await iniciarSesion(empresaId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/sesion/:empresaId/qr', authMiddleware, async (req, res) => {
  const { empresaId } = req.params;
  const sesion = sesiones.get(empresaId);
  if (!sesion) return res.status(404).json({ error: 'Sesion no encontrada' });
  if (sesion.status === 'connected') return res.json({ status: 'connected', numero: sesion.numero });
  if (sesion.qrBase64) return res.json({ status: 'qr_ready', qrBase64: sesion.qrBase64 });
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = sesiones.get(empresaId);
    if (s?.qrBase64) return res.json({ status: 'qr_ready', qrBase64: s.qrBase64 });
    if (s?.status === 'connected') return res.json({ status: 'connected', numero: s.numero });
  }
  res.status(408).json({ error: 'Timeout esperando QR' });
});

app.get('/sesion/:empresaId/status', authMiddleware, (req, res) => {
  const s = sesiones.get(req.params.empresaId);
  res.json(s ? { status: s.status, numero: s.numero } : { status: 'not_started' });
});

app.post('/sesion/:empresaId/iniciar-pairing', authMiddleware, async (req, res) => {
  const { empresaId } = req.params;
  try {
    const existente = sesiones.get(empresaId);
    if (existente?.sock) try { existente.sock.end(); } catch {}
    sesiones.delete(empresaId);
    await crearSocket(empresaId, true);
    await new Promise(r => setTimeout(r, 3000));
    res.json({ ok: true, status: 'ready_for_pairing' });
  } catch (e) {
    console.error(`[${empresaId}] iniciar-pairing error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sesion/:empresaId/pairing-code', authMiddleware, async (req, res) => {
  const { empresaId } = req.params;
  const { telefono }  = req.body;
  if (!telefono) return res.status(400).json({ error: 'telefono requerido' });
  const sesion = sesiones.get(empresaId);
  if (!sesion?.sock) return res.status(400).json({ error: 'Primero llama a /iniciar-pairing' });
  if (sesion.status === 'connected') return res.json({ ok: true, status: 'already_connected', numero: sesion.numero });
  try {
    const tel = telefono.replace(/\D/g, '');
    console.log(`[${empresaId}] Solicitando pairing code para ${tel}...`);
    const code = await sesion.sock.requestPairingCode(tel);
    const rawCode = String(code || '');
    console.log(`[${empresaId}] Pairing code: "${rawCode}" (${rawCode.length} chars)`);
    res.json({ ok: true, code: rawCode, raw: rawCode });
  } catch (e) {
    console.error(`[${empresaId}] requestPairingCode error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sesion/:empresaId/desconectar', authMiddleware, async (req, res) => {
  const { empresaId } = req.params;
  const sesion = sesiones.get(empresaId);
  if (sesion?.sock) try { await sesion.sock.logout(); } catch {}
  const sessionDir = path.join('/tmp', 'wa_sessions', empresaId);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  await deleteSessionFromFirestore(empresaId);
  sesiones.delete(empresaId);
  await db.collection('empresas').doc(empresaId).set(
    { whatsapp: { status: 'disconnected', activo: false, numero: null } }, { merge: true }
  ).catch(() => {});
  res.json({ ok: true });
});

app.get('/sesiones', authMiddleware, async (req, res) => {
  const enMemoria = [...sesiones.entries()].map(([id, s]) => ({ empresaId: id, status: s.status, numero: s.numero }));
  const snap = await db.collection('wa_sessions').get();
  res.json({ enMemoria, enFirestore: snap.docs.map(d => d.id) });
});

app.delete('/sesion/:empresaId', authMiddleware, async (req, res) => {
  const { empresaId } = req.params;
  const sesion = sesiones.get(empresaId);
  if (sesion?.sock) try { await sesion.sock.logout(); } catch {}
  const sessionDir = path.join('/tmp', 'wa_sessions', empresaId);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  await deleteSessionFromFirestore(empresaId);
  sesiones.delete(empresaId);
  res.json({ ok: true });
});

app.delete('/sesiones/todas', authMiddleware, async (req, res) => {
  const snap = await db.collection('wa_sessions').get();
  for (const d of snap.docs) {
    const s = sesiones.get(d.id);
    if (s?.sock) try { await s.sock.logout(); } catch {}
    sesiones.delete(d.id);
    await d.ref.delete();
  }
  fs.rmSync(path.join('/tmp', 'wa_sessions'), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post('/enviar', authMiddleware, async (req, res) => {
  const { empresaId, numero, texto } = req.body;
  const sesion = sesiones.get(empresaId);
  if (!sesion || sesion.status !== 'connected') return res.status(400).json({ error: 'No conectado' });
  try {
    const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    await sesion.sock.sendMessage(jid, { text: texto });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Endpoint manual para forzar la revision de recordatorios/seguimientos
//    (util para pruebas — en produccion corre solo via setInterval) ──
app.post('/admin/revisar-automaticos', authMiddleware, async (req, res) => {
  try {
    await correrTareasAutomaticas();
    res.json({ ok: true, ejecutado: true, horaPermitida: dentroHorarioPermitido() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, async () => {
  console.log(`\nagencIAme WhatsApp Server v4 en puerto ${PORT}`);
  console.log(`API Vercel: ${AGENCIAME_API}`);
  console.log(`Secret: ${SERVER_SECRET ? 'OK' : 'FALTA'}`);
  await restaurarSesiones();

  // Esperar 1 minuto a que las sesiones reconecten antes de la primera corrida
  setTimeout(() => {
    correrTareasAutomaticas();
    // Cada 15 minutos
    setInterval(correrTareasAutomaticas, 15 * 60 * 1000);
  }, 60000);
});
