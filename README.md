# agencIAme WhatsApp Server

Servidor multi-empresa para WhatsApp usando Baileys + Railway.

## Deploy en Railway (paso a paso)

### 1. Subir a GitHub

```bash
# En tu computador, crea la carpeta
mkdir agenciame-whatsapp-server
# Copia todos los archivos de esta carpeta
# Luego:
cd agenciame-whatsapp-server
git init
git add .
git commit -m "inicial"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/agenciame-whatsapp-server.git
git push -u origin main
```

### 2. Crear proyecto en Railway

1. Ir a https://railway.app
2. Click "New Project"
3. Seleccionar "Deploy from GitHub repo"
4. Seleccionar el repo `agenciame-whatsapp-server`
5. Railway detecta automáticamente que es Node.js

### 3. Configurar variables de entorno en Railway

En Railway > tu proyecto > Variables, agregar:

| Variable | Valor |
|---|---|
| `SERVER_SECRET` | Una cadena aleatoria larga (ej: `abc123xyz789secreto`) |
| `AGENCIAME_API_URL` | `https://nexoia-soporteias-projects.vercel.app` |
| `FIREBASE_SERVICE_ACCOUNT` | JSON completo en una sola linea (ver abajo) |

### 4. Obtener Firebase Service Account

1. Ir a https://console.firebase.google.com
2. Seleccionar proyecto `nexoia-c7864`
3. Configuracion del proyecto (engranaje) > Cuentas de servicio
4. Click "Generar nueva clave privada"
5. Descarga el JSON
6. Abre el JSON, copia TODO el contenido
7. En Railway, pega el JSON completo como valor de `FIREBASE_SERVICE_ACCOUNT`

### 5. Obtener URL del servidor

Despues del deploy Railway asigna una URL como:
`https://agenciame-whatsapp-server-production.up.railway.app`

**Guarda esta URL** — la necesitas para configurar en Vercel.

### 6. Agregar variables en Vercel (agencIAme)

En Vercel > nexoia > Settings > Environment Variables:

| Variable | Valor |
|---|---|
| `WHATSAPP_SERVER_URL` | URL de Railway del paso 5 |
| `SERVER_SECRET` | El mismo secreto que pusiste en Railway |

### 7. Copiar el archivo API a agencIAme

Copiar `agenciame-api-whatsapp-baileys.js` a:
`E:\DATOS\copiacontroltecnologico\nexoia\pages\api\whatsapp-baileys.js`

## Estructura de sesiones

Cada empresa tiene su sesion en la carpeta `sessions/EMPRESA_ID/`
Railway persiste estas carpetas entre deploys si configuras un volumen.

## Endpoints

| Metodo | Ruta | Descripcion |
|---|---|---|
| GET | `/health` | Estado del servidor |
| POST | `/sesion/iniciar` | Iniciar sesion (genera QR) |
| GET | `/sesion/:id/qr` | Obtener QR como imagen |
| GET | `/sesion/:id/status` | Estado de la sesion |
| POST | `/sesion/:id/desconectar` | Cerrar sesion |
| POST | `/enviar` | Enviar mensaje |

Todos los endpoints (excepto /health) requieren header:
`x-server-secret: TU_SERVER_SECRET`
