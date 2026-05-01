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

const usuarioSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    rol: { type: String, required: true }
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

// Configuración de almacenamiento
const carpetaDocs = path.join(__dirname, 'documentos_guardados');
if (!fs.existsSync(carpetaDocs)) fs.mkdirSync(carpetaDocs);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, carpetaDocs),
    filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage: storage });

// ---------------------------------------------------------
// 🔐 ENDPOINTS: SEGURIDAD Y USUARIOS
// ---------------------------------------------------------

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const usuarioEncontrado = await Usuario.findOne({ username, password });
        if (usuarioEncontrado) {
            res.json({ ok: true, username: usuarioEncontrado.username, rol: usuarioEncontrado.rol });
        } else {
            res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error en base de datos' });
    }
});

// Obtener lista para el selector de asignación
app.get('/api/usuarios', async (req, res) => {
    try {
        const usuarios = await Usuario.find({ rol: { $in: ['admin', 'editor'] } }, 'username');
        res.json(usuarios);
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo usuarios' });
    }
});

// Crear nuevo usuario (Solo Admin)
app.post('/api/usuarios', async (req, res) => {
    try {
        const { requesterRol, nuevoUsername, nuevoPassword, nuevoRol } = req.body;
        
        // 1. Verificación de permisos: Solo admin crea usuarios
        if (requesterRol !== 'admin') {
            return res.status(403).json({ error: 'Solo el administrador puede crear usuarios' });
        }

        // 2. LÍMITE DE ADMINISTRADORES (Actualizado a 5 según solicitud)
        if (nuevoRol === 'admin') {
            const conteoAdmins = await Usuario.countDocuments({ rol: 'admin' });
            if (conteoAdmins >= 5) {
                return res.status(400).json({ error: 'Límite alcanzado: El sistema solo soporta un máximo de 5 Administradores.' });
            }
        }

        // 3. Verificación de existencia
        const existe = await Usuario.findOne({ username: nuevoUsername });
        if (existe) return res.status(400).json({ error: 'El nombre de usuario ya existe' });

        // 4. Guardado en BD
        const nuevoUser = new Usuario({ 
            username: nuevoUsername, 
            password: nuevoPassword, 
            rol: nuevoRol 
        });
        
        await nuevoUser.save();
        res.json({ mensaje: 'Usuario registrado con éxito' });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear el usuario' });
    }
});

// ---------------------------------------------------------
// 📋 ENDPOINTS: DOCUMENTOS Y PROTECCIÓN
// ---------------------------------------------------------

app.get('/api/documentos', async (req, res) => {
    try {
        const { username, rol } = req.query;
        let filtro = {};
        if (rol === 'editor') filtro = { asignado_a: { $in: [username, 'todos'] } };
        const historial = await Documento.find(filtro).sort({ fecha: -1 });
        res.json(historial);
    } catch (error) {
        res.status(500).json({ error: 'Error al leer el historial' });
    }
});

app.get('/api/descargar/:nombre', (req, res) => {
    const { rol } = req.query;
    if (rol === 'viewer') {
        return res.status(403).send('Acceso denegado: Los invitados no pueden descargar.');
    }
    res.download(path.join(carpetaDocs, req.params.nombre));
});

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
        if (!req.file) return res.status(400).json({ error: 'Falta archivo' });
        const asignadoA = req.body.asignado_a || 'todos';
        let textoLimpio = "";

        if (req.file.mimetype === 'application/pdf') {
            const pdfBuffer = fs.readFileSync(req.file.path);
            const pdfData = await pdfParse(pdfBuffer);
            textoLimpio = pdfData.text;
        } else {
            textoLimpio = fs.readFileSync(req.file.path, 'utf-8');
        }

        const promptOficina = `Eres un asistente estricto. Resume en 2 líneas y asigna prioridad (Rojo, Ámbar o Verde) para este texto: ### ${textoLimpio.substring(0, 2500)} ###`;

        const respuestaOllama = await fetch('http://nginx/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama3.2', prompt: promptOficina, stream: false })
        });

        const datosIA = await respuestaOllama.json();

        const nuevoRegistro = new Documento({
            archivo_original: req.file.originalname,
            archivo_guardado: req.file.filename,
            resultado_ia: datosIA.response,
            asignado_a: asignadoA
        });

        await nuevoRegistro.save();
        res.json(nuevoRegistro);
    } catch (error) {
        res.status(500).json({ error: 'Error procesando documento' });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en el puerto ${PORT}`);
});