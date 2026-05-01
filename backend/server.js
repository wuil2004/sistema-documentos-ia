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
    username: { type: String, required: true },
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
    asignado_a: String // <--- NUEVO: ¿A quién le toca este doc?
});
const Documento = mongoose.model('Documento', documentoSchema);

const carpetaDocs = path.join(__dirname, 'documentos_guardados');
if (!fs.existsSync(carpetaDocs)) fs.mkdirSync(carpetaDocs);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, carpetaDocs),
    filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage: storage });

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

// ---------------------------------------------------------
// 📋 ENDPOINT MODIFICADO: FILTRAR POR USUARIO
// ---------------------------------------------------------
app.get('/api/documentos', async (req, res) => {
    try {
        const { username, rol } = req.query; // Recibimos quién es el que pregunta
        let filtro = {};

        // LÓGICA DE NEGOCIO:
        // Si es editor (williams, abril), SOLO ve los que están a su nombre o a 'todos'
        if (rol === 'editor') {
            filtro = { asignado_a: { $in: [username, 'todos'] } };
        }
        // Si es admin o viewer, el filtro se queda vacío (ven todos)

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
// 🚀 ENDPOINT MODIFICADO: GUARDAR A QUIÉN SE LE ASIGNA
// ---------------------------------------------------------
app.post('/api/analizar', upload.single('documento'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Falta PDF' });

        const asignadoA = req.body.asignado_a || 'todos'; // Recibimos a quién va dirigido

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
            asignado_a: asignadoA // <--- Lo guardamos en la Base de Datos
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