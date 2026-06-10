// server.js — agencIAme WhatsApp Multi-Empresa Server
// Cada empresa tiene su propia sesion Baileys identificada por empresaId

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
const require = createRequire(import.meta.url);

// ── Firebase Admin ────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Config ────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3001;
const SERVER_SECRET = process.env.SERVER_SECRET || 'agenciame2026secret';
const AGENCIAME_API = process.env.AGENCIAME_API_URL || 'https://nexoia-soporteias-projects.vercel.app';

// ── Sesiones en memoria ───────────────────────────────────────────────────
// Map: empresaId -> { sock, status, qr, qrBase64, mensajesPendientes }
const sesiones = new Map();
const msgCache = new NodeCache({ stdTTL: 300 }); // 5 minutos — evita duplicados tras reinicios
const logger   = pino({ level: 'warn' }); // silencioso en produccion

// ── Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Middleware de autenticacion
const auth = (req, res, next) => {
  const token = req.headers['x-server-secret'] || req.query.secret;
  if (token !== SERVER_SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
};

// ── Baileys dinamico (importado en runtime) ───────────────────────────────
async function getBaileys() {
  const mod = await import('@whiskeysockets/baileys');
  return mod;
}

// ── Crear/reconectar sesion para una empresa ──────────────────────────────
async function iniciarSesion(empresaId) {
  // Si ya hay sesion activa, no hacer nada
  const existente = sesiones.get(empresaId);
  if (existente && existente.status === 'connected') {
    return { status: 'already_connected' };
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
  } = await getBaileys();

  // Carpeta de sesion persistente por empresa
  const sessionDir = path.join(__dirname, 'sessions', empresaId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  const sesionData = {
    sock,
    status: 'connecting',
    qr: null,
    qrBase64: null,
    empresaId,
    numero: null,
  };
  sesiones.set(empresaId, sesionData);

  // ── Eventos Baileys ───────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // Generar QR como imagen base64
      const qrBase64 = await qrcode.toDataURL(qr);
      sesionData.qr      = qr;
      sesionData.qrBase64 = qrBase64;
      sesionData.status  = 'qr_ready';

      // Guardar QR en Firestore para que el dashboard lo muestre
      await db.collection('empresas').doc(empresaId).update({
        'whatsapp.status': 'qr_ready',
        'whatsapp.qrBase64': qrBase64,
        'whatsapp.updatedAt': FieldValue.serverTimestamp(),
      }).catch(() => {});

      console.log(`[${empresaId}] QR listo para escanear`);
    }

    if (connection === 'open') {
      sesionData.status   = 'connected';
      sesionData.qr       = null;
      sesionData.qrBase64 = null;
      const numero = sock.user?.id?.split(':')[0] || '';
      sesionData.numero   = numero;

      // Actualizar Firestore: conectado
      await db.collection('empresas').doc(empresaId).update({
        'whatsapp.status':    'connected',
        'whatsapp.numero':    numero,
        'whatsapp.qrBase64':  null,
        'whatsapp.connectedAt': FieldValue.serverTimestamp(),
      }).catch(() => {});

      console.log(`[${empresaId}] WhatsApp conectado - numero: ${numero}`);
    }

    if (connection === 'close') {
      const code    = lastDisconnect?.error?.output?.statusCode;
      const logout  = code === DisconnectReason.loggedOut;
      sesionData.status = logout ? 'disconnected' : 'reconnecting';

      if (logout) {
        // Limpiar sesion si se cerro sesion
        fs.rmSync(path.join(__dirname, 'sessions', empresaId), { recursive: true, force: true });
        sesiones.delete(empresaId);
        await db.collection('empresas').doc(empresaId).update({
          'whatsapp.status': 'disconnected',
          'whatsapp.numero': null,
        }).catch(() => {});
        console.log(`[${empresaId}] Sesion cerrada (logout)`);
      } else {
        // Reconectar automaticamente
        console.log(`[${empresaId}] Desconectado, reconectando...`);
        setTimeout(() => iniciarSesion(empresaId), 5000);
      }
    }
  });

  // ── Recibir mensajes ──────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // ❌ Ignorar mensajes propios (enviados por el bot)
      if (msg.key.fromMe) continue;
      if (!msg.message)   continue;

      // ❌ Ignorar mensajes de sistema, grupos y broadcasts
      const from = msg.key.remoteJid;
      if (!from) continue;
      if (from.endsWith('@g.us'))           continue; // grupos
      if (from === 'status@broadcast')      continue; // estados
      if (from.endsWith('@broadcast'))      continue; // broadcasts

      // ❌ Ignorar mensajes muy antiguos (mas de 60 segundos)
      const msgTimestamp = msg.messageTimestamp;
      if (msgTimestamp && Date.now() / 1000 - msgTimestamp > 60) {
        console.log(`[${empresaId}] Mensaje antiguo ignorado: ${new Date(msgTimestamp * 1000).toISOString()}`);
        continue;
      }

      // ❌ Evitar procesar el mismo mensaje dos veces
      const msgId = msg.key.id;
      if (!msgId) continue;
      if (msgCache.get(msgId)) {
        console.log(`[${empresaId}] Mensaje duplicado ignorado: ${msgId}`);
        continue;
      }
      msgCache.set(msgId, true);

      // Extraer texto
      const texto =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!texto || texto.trim().length === 0) continue;

      const numeroCliente = from.replace('@s.whatsapp.net', '');
      console.log(`[${empresaId}] Mensaje de ${numeroCliente}: ${texto.substring(0, 60)}`);

      // Enviar a la API de agencIAme
      try {
        const resp = await axios.post(
          `${AGENCIAME_API}/api/whatsapp-baileys`,
          { empresaId, numeroCliente, texto, msgId },
          { headers: { 'x-server-secret': SERVER_SECRET }, timeout: 25000 }
        );

        const respuesta = resp.data?.respuesta;
        if (respuesta && respuesta.trim().length > 0) {
          await sock.sendMessage(from, { text: respuesta });
          console.log(`[${empresaId}] Respuesta enviada a ${numeroCliente}`);
        }
      } catch (err) {
        console.error(`[${empresaId}] Error:`, err.message);
        // Solo enviar fallback si NO es un error de la IA (para no spamear)
        if (err.code !== 'ECONNABORTED' && err.response?.status !== 500) {
          await sock.sendMessage(from, {
            text: 'En este momento no puedo procesar tu mensaje. Por favor intenta en unos minutos.',
          });
        }
      }
    }
  });

  return { status: 'starting' };
}

// ── Restaurar sesiones activas al iniciar el servidor ────────────────────
async function restaurarSesiones() {
  const sessionDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionDir)) return;

  const empresas = fs.readdirSync(sessionDir);
  console.log(`Restaurando ${empresas.length} sesiones...`);

  for (const empresaId of empresas) {
    try {
      await iniciarSesion(empresaId);
      await new Promise(r => setTimeout(r, 1000)); // esperar 1s entre conexiones
    } catch (err) {
      console.error(`Error restaurando sesion ${empresaId}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RUTAS API
// ═══════════════════════════════════════════════════════════════════════

// GET /health — estado del servidor
app.get('/health', (req, res) => {
  const activas = [...sesiones.values()].filter(s => s.status === 'connected').length;
  res.json({
    ok: true,
    sesionesActivas: activas,
    sesionesTotales: sesiones.size,
    uptime: process.uptime(),
  });
});

// POST /sesion/iniciar — iniciar sesion para una empresa (genera QR)
app.post('/sesion/iniciar', auth, async (req, res) => {
  const { empresaId } = req.body;
  if (!empresaId) return res.status(400).json({ error: 'empresaId requerido' });

  try {
    const result = await iniciarSesion(empresaId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Error iniciando sesion:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /sesion/:empresaId/qr — obtener QR actual como imagen base64
app.get('/sesion/:empresaId/qr', auth, async (req, res) => {
  const { empresaId } = req.params;
  const sesion = sesiones.get(empresaId);

  if (!sesion) {
    return res.status(404).json({ error: 'Sesion no encontrada. Inicia la sesion primero.' });
  }

  if (sesion.status === 'connected') {
    return res.json({ status: 'connected', numero: sesion.numero });
  }

  if (sesion.status === 'qr_ready' && sesion.qrBase64) {
    return res.json({ status: 'qr_ready', qrBase64: sesion.qrBase64 });
  }

  // Esperar hasta 15s a que aparezca el QR
  let intentos = 0;
  const esperar = () => new Promise(resolve => setTimeout(resolve, 1000));

  while (intentos < 15) {
    await esperar();
    const s = sesiones.get(empresaId);
    if (s?.qrBase64)          return res.json({ status: 'qr_ready', qrBase64: s.qrBase64 });
    if (s?.status === 'connected') return res.json({ status: 'connected', numero: s.numero });
    intentos++;
  }

  res.status(408).json({ error: 'Tiempo de espera agotado. Reintenta.' });
});

// GET /sesion/:empresaId/status — estado de la sesion
app.get('/sesion/:empresaId/status', auth, async (req, res) => {
  const { empresaId } = req.params;
  const sesion = sesiones.get(empresaId);

  if (!sesion) return res.json({ status: 'not_started', empresaId });

  res.json({
    status:  sesion.status,
    numero:  sesion.numero,
    empresaId,
  });
});

// POST /sesion/:empresaId/desconectar — desconectar empresa
app.post('/sesion/:empresaId/desconectar', auth, async (req, res) => {
  const { empresaId } = req.params;
  const sesion = sesiones.get(empresaId);

  if (sesion?.sock) {
    try {
      await sesion.sock.logout();
    } catch {}
  }

  fs.rmSync(path.join(__dirname, 'sessions', empresaId), { recursive: true, force: true });
  sesiones.delete(empresaId);

  await db.collection('empresas').doc(empresaId).update({
    'whatsapp.status': 'disconnected',
    'whatsapp.numero': null,
  }).catch(() => {});

  res.json({ ok: true, mensaje: 'Sesion desconectada' });
});

// POST /enviar — enviar mensaje desde la plataforma (para notificaciones)
app.post('/enviar', auth, async (req, res) => {
  const { empresaId, numero, texto } = req.body;
  if (!empresaId || !numero || !texto) {
    return res.status(400).json({ error: 'empresaId, numero y texto requeridos' });
  }

  const sesion = sesiones.get(empresaId);
  if (!sesion || sesion.status !== 'connected') {
    return res.status(400).json({ error: 'Empresa no conectada a WhatsApp' });
  }

  try {
    const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    await sesion.sock.sendMessage(jid, { text: texto });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Iniciar servidor ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`agencIAme WhatsApp Server corriendo en puerto ${PORT}`);
  await restaurarSesiones();
});
