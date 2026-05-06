const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-extraction');
const mammoth = require('mammoth'); 
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
                /*{ username: "invitado", password: "123", rol: "viewer" } */
            ]);
            console.log('👥 Usuarios iniciales inyectados en la Base de Datos');
        }
    })
    .catch(err => console.error('❌ Error conectando a Mongo:', err));

const usuarioSchema = new mongoose.Schema({
    username: { type: String, required: true },
    password: { type: String, required: true },
    rol: { type: String, required: true },
    ultimo_latido: { type: Date, default: null },
    token_sesion: { type: String, default: null } 
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
// 🔐 ENDPOINT: LOGIN
// ---------------------------------------------------------
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const usuarioEncontrado = await Usuario.findOne({ username, password });
        
        if (!usuarioEncontrado) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });

        if (usuarioEncontrado.rol !== 'viewer') {
            const ahora = Date.now();
            const limiteActividad = 15000; 
            if (usuarioEncontrado.ultimo_latido && (ahora - new Date(usuarioEncontrado.ultimo_latido).getTime() < limiteActividad)) {
                return res.status(403).json({ ok: false, error: 'Acceso denegado: Sesión activa en otro dispositivo, o bien intente más tarde.' });
            }
        }

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
// 💓 ENDPOINT: LATIDOS Y LOGOUT
// ---------------------------------------------------------
app.post('/api/latido', async (req, res) => {
    try {
        const { username, token_sesion } = req.body;
        if (!username || !token_sesion) return res.status(400).json({ error: "Faltan datos" });

        const usuarioEncontrado = await Usuario.findOne({ username });
        if (!usuarioEncontrado || usuarioEncontrado.token_sesion !== token_sesion) {
            return res.status(403).json({ error: "Sesión robada" });
        }

        usuarioEncontrado.ultimo_latido = Date.now();
        await usuarioEncontrado.save();
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Error en latido" });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        await Usuario.findOneAndUpdate({ username: req.body.username }, { ultimo_latido: null, token_sesion: null });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Error al cerrar sesión" });
    }
});

// ---------------------------------------------------------
// 👥 ENDPOINTS: USUARIOS
// ---------------------------------------------------------
app.get('/api/usuarios', async (req, res) => {
    try {
        const usuarios = await Usuario.find({ rol: { $in: ['editor'] } }, 'username');
        res.json(usuarios);
    } catch (error) { res.status(500).json({ error: 'Error obteniendo usuarios' }); }
});

app.post('/api/usuarios', async (req, res) => {
    try {
        const { requesterRol, nuevoUsername, nuevoPassword, nuevoRol } = req.body;
        if (requesterRol !== 'admin') return res.status(403).json({ error: 'Solo admin' });

        if (nuevoRol === 'admin') {
            const conteoAdmins = await Usuario.countDocuments({ rol: 'admin' });
            if (conteoAdmins >= 10) return res.status(400).json({ error: 'Límite de 10 Administradores alcanzado.' });
        }

        if (await Usuario.findOne({ username: nuevoUsername })) return res.status(400).json({ error: 'Usuario ya existe' });

        await new Usuario({ username: nuevoUsername, password: nuevoPassword, rol: nuevoRol }).save();
        res.json({ mensaje: 'Usuario registrado con éxito' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// ---------------------------------------------------------
// 📋 ENDPOINTS: DOCUMENTOS E IA
// ---------------------------------------------------------
app.get('/api/documentos', async (req, res) => {
    try {
        const { username, rol } = req.query;
        let filtro = rol === 'editor' ? { asignado_a: { $in: [username, 'todos'] } } : {};
        const historial = await Documento.find(filtro).sort({ fecha: -1 });
        res.json(historial);
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/descargar/:nombre', (req, res) => {
    res.download(path.join(carpetaDocs, req.params.nombre));
});

app.get('/api/ver/:nombre', (req, res) => {
    const rutaArchivo = path.join(carpetaDocs, req.params.nombre);
    if (fs.existsSync(rutaArchivo)) res.sendFile(rutaArchivo);
    else res.status(404).send('Archivo no encontrado');
});

// 🧠 EXTRACCIÓN MULTIFORMATO
app.post('/api/analizar', upload.single('documento'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Falta documento' });
        const asignadoA = req.body.asignado_a || 'todos';
        const extension = path.extname(req.file.originalname).toLowerCase();
        
        let textoLimpio = "";

        if (extension === '.pdf') {
            const pdfBuffer = fs.readFileSync(req.file.path);
            const pdfData = await pdfParse(pdfBuffer);
            textoLimpio = pdfData.text.trim();
        } 
        else if (extension === '.txt') {
            textoLimpio = fs.readFileSync(req.file.path, 'utf-8').trim();
        } 
        else if (extension === '.docx') {
            const result = await mammoth.extractRawText({ path: req.file.path });
            textoLimpio = result.value.trim();
        } 
        else {
            fs.unlinkSync(req.file.path); 
            return res.status(400).json({ error: 'Formato no soportado.' });
        }

        textoLimpio = textoLimpio.substring(0, 3000);

        if(!textoLimpio) return res.status(400).json({ error: 'El documento está vacío o no se pudo leer.' });

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

        // 🔥 CORRECCIÓN AQUÍ: Si Nginx nos manda un historial de saltos separados por comas, 
        // agarramos solo el último elemento, que es el que respondió con éxito.
        let nodoQueTrabajo = respuestaOllama.headers.get('x-nodo-ia') || 'Desconocido';
        nodoQueTrabajo = nodoQueTrabajo.split(',').pop().trim();

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
        res.status(500).json({ error: 'Error procesando el documento' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en el puerto ${PORT}`);
});