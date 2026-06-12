// server.js — agencIAme WhatsApp Multi-Empresa Server
// v2: soporte QR + Pairing Code (sin segundo dispositivo)

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
        if (respuesta?.trim()) await sock.sendMessage(from, { text: respuesta });
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

// ── PAIRING CODE paso 1: iniciar socket en modo pairing ───────
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

// ── PAIRING CODE paso 2: solicitar codigo de 8 digitos ────────
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

    // ── FIX: enviar el codigo RAW sin ninguna modificacion ────
    // Baileys devuelve exactamente 8 chars: "ABCD1234"
    // El regex anterior /(.{4})(?=.)/ cortaba el ultimo digito
    // El frontend divide visualmente en bloques para mostrar
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

app.listen(PORT, async () => {
  console.log(`\nagencIAme WhatsApp Server v2 en puerto ${PORT}`);
  console.log(`API Vercel: ${AGENCIAME_API}`);
  console.log(`Secret: ${SERVER_SECRET ? 'OK' : 'FALTA'}`);
  await restaurarSesiones();
});
