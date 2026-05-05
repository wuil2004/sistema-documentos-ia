const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-extraction');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
// 🗄️ CONEXIÓN Y MODELOS DE MONGODB
// ---------------------------------------------------------
mongoose.connect('mongodb://mongo:27017/sistema_documentos')
    .then(async () => {
        console.log('🟢 Conectado exitosamente a MongoDB');
        const conteo = await Usuario.countDocuments();
        if (conteo === 0) {
            await Usuario.insertMany([
                { username: "admin", password: "123", rol: "admin" },
                { username: "williams", password: "123", rol: "editor" },
                { username: "abril", password: "123", rol: "editor" },
                { username: "invitado", password: "123", rol: "viewer" }
            ]);
            console.log('👥 Usuarios iniciales inyectados en la Base de Datos');
        }
    })
    .catch(err => console.error('❌ Error conectando a Mongo:', err));

// 🚨 ACTUALIZACIÓN DE ESQUEMA DE SEGURIDAD (NUEVO)
const usuarioSchema = new mongoose.Schema({
    username: { type: String, required: true },
    password: { type: String, required: true },
    rol: { type: String, required: true },
    ultimo_latido: { type: Date, default: null }, // Para saber cuándo fue su última señal
    token_sesion: { type: String, default: null } // Para identificar qué computadora tiene la cuenta
});
const Usuario = mongoose.model('Usuario', usuarioSchema);

const documentoSchema = new mongoose.Schema({
    archivo_original: String,
    archivo_guardado: String,
    fecha: { type: Date, default: Date.now },
    procesado_por: String,
    resultado_ia: String,
    asignado_a: String
});
const Documento = mongoose.model('Documento', documentoSchema);

const carpetaDocs = path.join(__dirname, 'documentos_guardados');
if (!fs.existsSync(carpetaDocs)) fs.mkdirSync(carpetaDocs);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, carpetaDocs),
    filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage: storage });

// ---------------------------------------------------------
// 🔐 ENDPOINT: LOGIN (MODIFICADO PARA CONCURRENCIA)
// ---------------------------------------------------------
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const usuarioEncontrado = await Usuario.findOne({ username, password });
        
        if (!usuarioEncontrado) {
            return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        }

        // LÓGICA DE PROTECCIÓN DE CUENTAS (Excluimos al visitante/viewer)
        if (usuarioEncontrado.rol !== 'viewer') {
            const ahora = Date.now();
            const limiteActividad = 15000; // 15 segundos de tolerancia
            
            // Si tiene un latido registrado y fue hace menos de 15 segundos = Alguien lo está usando
            if (usuarioEncontrado.ultimo_latido && (ahora - new Date(usuarioEncontrado.ultimo_latido).getTime() < limiteActividad)) {
                return res.status(403).json({ 
                    ok: false, 
                    error: 'Acceso denegado: El usuario ya tiene una sesión activa en otro dispositivo.' 
                });
            }
        }

        // Si la cuenta está libre, generamos un candado (token) único para esta nueva PC
        const token_sesion = Math.random().toString(36).substring(2) + Date.now().toString(36);
        usuarioEncontrado.token_sesion = token_sesion;
        usuarioEncontrado.ultimo_latido = Date.now();
        await usuarioEncontrado.save();

        res.json({ ok: true, username: usuarioEncontrado.username, rol: usuarioEncontrado.rol, token_sesion });
        
    } catch (error) {
        res.status(500).json({ error: 'Error en base de datos' });
    }
});

// ---------------------------------------------------------
// 💓 NUEVO ENDPOINT: RECIBIR LATIDOS DE MANTENIMIENTO
// ---------------------------------------------------------
app.post('/api/latido', async (req, res) => {
    try {
        const { username, token_sesion } = req.body;
        if (!username || !token_sesion) return res.status(400).json({ error: "Faltan datos de sesión" });

        const usuarioEncontrado = await Usuario.findOne({ username });
        if (!usuarioEncontrado) return res.status(404).json({ error: "Usuario no existe" });

        // Si el token que manda la PC no es igual al de la BD, significa que se le dio acceso a otra máquina
        if (usuarioEncontrado.token_sesion !== token_sesion) {
            return res.status(403).json({ error: "Sesión robada o caducada" });
        }

        // Si todo coincide, actualizamos su última hora de vida
        usuarioEncontrado.ultimo_latido = Date.now();
        await usuarioEncontrado.save();

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Error procesando latido" });
    }
});

// ---------------------------------------------------------
// 🚪 NUEVO ENDPOINT: CIERRE MANUAL DE SESIÓN
// ---------------------------------------------------------
app.post('/api/logout', async (req, res) => {
    try {
        const { username } = req.body;
        // Limpiamos los datos para liberar la cuenta inmediatamente
        await Usuario.findOneAndUpdate({ username }, { ultimo_latido: null, token_sesion: null });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Error al cerrar sesión" });
    }
});

// ---------------------------------------------------------
// 👥 ENDPOINTS: GESTIÓN DE USUARIOS
// ---------------------------------------------------------
app.get('/api/usuarios', async (req, res) => {
    try {
        const usuarios = await Usuario.find({ rol: { $in: ['admin', 'editor'] } }, 'username');
        res.json(usuarios);
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo usuarios' });
    }
});

app.post('/api/usuarios', async (req, res) => {
    try {
        const { requesterRol, nuevoUsername, nuevoPassword, nuevoRol } = req.body;

        if (requesterRol !== 'admin') {
            return res.status(403).json({ error: 'Solo el administrador puede crear usuarios' });
        }

        if (nuevoRol === 'admin') {
            const conteoAdmins = await Usuario.countDocuments({ rol: 'admin' });
            if (conteoAdmins >= 10) {
                return res.status(400).json({ error: 'Límite alcanzado: El sistema solo soporta un máximo de 10 Administradores.' });
            }
        }

        const existe = await Usuario.findOne({ username: nuevoUsername });
        if (existe) {
            return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
        }

        const nuevoUser = new Usuario({ username: nuevoUsername, password: nuevoPassword, rol: nuevoRol });
        await nuevoUser.save();

        res.json({ mensaje: 'Usuario registrado con éxito' });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear el usuario' });
    }
});

// ---------------------------------------------------------
// 📋 ENDPOINTS: DOCUMENTOS E IA
// ---------------------------------------------------------
app.get('/api/documentos', async (req, res) => {
    try {
        const { username, rol } = req.query;
        let filtro = {};
        if (rol === 'editor') {
            filtro = { asignado_a: { $in: [username, 'todos'] } };
        }
        const historial = await Documento.find(filtro).sort({ fecha: -1 });
        res.json(historial);
    } catch (error) {
        res.status(500).json({ error: 'Error al leer el historial' });
    }
});

app.get('/api/descargar/:nombre', (req, res) => {
    res.download(path.join(carpetaDocs, req.params.nombre));
});

// ---------------------------------------------------------
// 👁️ ENDPOINT: VER PDF (Visor Seguro)
// ---------------------------------------------------------
app.get('/api/ver/:nombre', (req, res) => {
    const rutaArchivo = path.join(carpetaDocs, req.params.nombre);
    if (fs.existsSync(rutaArchivo)) {
        res.sendFile(rutaArchivo);
    } else {
        res.status(404).send('Archivo no encontrado');
    }
});

app.post('/api/analizar', upload.single('documento'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Falta PDF' });
        const asignadoA = req.body.asignado_a || 'todos';

        const pdfBuffer = fs.readFileSync(req.file.path);
        const pdfData = await pdfParse(pdfBuffer);
        const textoLimpio = pdfData.text.trim().substring(0, 3000);

        const promptOficina = `Eres un asistente estricto. Tu única tarea es leer el texto delimitado por ### y devolver exactamente dos cosas:
1. Un resumen muy corto (máximo 2 líneas).
2. La prioridad (estrictamente la palabra Rojo, Ámbar o Verde).
PROHIBIDO devolver el texto original. PROHIBIDO dar explicaciones.
###
${textoLimpio}
###
Tu respuesta:`;

        const respuestaOllama = await fetch('http://nginx/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama3.2', prompt: promptOficina, stream: false })
        });

        const nodoQueTrabajo = respuestaOllama.headers.get('x-nodo-ia') || 'Desconocido';
        const datosIA = await respuestaOllama.json();

        const nuevoRegistro = new Documento({
            archivo_original: req.file.originalname,
            archivo_guardado: req.file.filename,
            procesado_por: nodoQueTrabajo,
            resultado_ia: datosIA.response,
            asignado_a: asignadoA
        });

        await nuevoRegistro.save();

        res.json({ mensaje: 'Éxito', registro: nuevoRegistro });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ error: 'Error procesando' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en el puerto ${PORT}`);
});