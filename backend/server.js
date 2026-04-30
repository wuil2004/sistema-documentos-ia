const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-extraction');
const cors = require('cors');
const fs = require('fs');     
const path = require('path'); 

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 👥 BASE DE DATOS DE USUARIOS (Arreglo en memoria)
// ---------------------------------------------------------
// El profe pide de 1 a 10 usuarios. Aquí tenemos 4 listos para probar.
const USUARIOS = [
    { username: "admin", password: "123", rol: "admin" },
    { username: "williams", password: "123", rol: "editor" },
    { username: "marlen", password: "123", rol: "editor" },
    { username: "invitado", password: "123", rol: "viewer" } // Los visitantes solo ven
];

// ---------------------------------------------------------
// 💾 CONFIGURACIÓN DE ALMACENAMIENTO (PERSISTENCIA)
// ---------------------------------------------------------
const carpetaDocs = path.join(__dirname, 'documentos_guardados');
const archivoHistorial = path.join(__dirname, 'historial.json');

if (!fs.existsSync(carpetaDocs)) {
    fs.mkdirSync(carpetaDocs);
}

if (!fs.existsSync(archivoHistorial)) {
    fs.writeFileSync(archivoHistorial, JSON.stringify([]));
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, carpetaDocs);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '_' + file.originalname);
    }
});
const upload = multer({ storage: storage });


// ---------------------------------------------------------
// 🔐 ENDPOINT 1: LOGIN DE USUARIOS
// ---------------------------------------------------------
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Buscamos si el usuario y la contraseña coinciden en nuestro arreglo
    const usuarioEncontrado = USUARIOS.find(u => u.username === username && u.password === password);

    if (usuarioEncontrado) {
        res.json({ ok: true, username: usuarioEncontrado.username, rol: usuarioEncontrado.rol });
    } else {
        res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    }
});


// ---------------------------------------------------------
// 📋 ENDPOINT 2: OBTENER HISTORIAL DE DOCUMENTOS
// ---------------------------------------------------------
app.get('/api/documentos', (req, res) => {
    try {
        // Leemos el archivo JSON y se lo mandamos al Frontend
        const historial = JSON.parse(fs.readFileSync(archivoHistorial));
        res.json(historial);
    } catch (error) {
        res.status(500).json({ error: 'Error al leer el historial de documentos' });
    }
});


// ---------------------------------------------------------
// 🚀 ENDPOINT 3: SUBIR Y ANALIZAR DOCUMENTO (El que ya tenías)
// ---------------------------------------------------------
app.post('/api/analizar', upload.single('documento'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Por favor sube un archivo PDF' });
        }

        console.log(`\n📥 Recibido: ${req.file.originalname}`);
        console.log("📄 Extrayendo texto del PDF desde el disco duro...");
        
        const pdfBuffer = fs.readFileSync(req.file.path); 
        const pdfData = await pdfParse(pdfBuffer);
        const textoExtraido = pdfData.text;

        const promptOficina = `Actúa como un asistente automático de oficina.
            Tu trabajo es leer el siguiente documento, generar un resumen de máximo 2 líneas y 
            clasificarlo con un nivel de prioridad usando estrictamente UNA de estas opciones: Rojo, 
            Ámbar o Verde.\n\nRegla de oro: NO des explicaciones adicionales, NO justifiques tu respuesta, 
            solo entrega el resumen y el color.\n\nDocumento: "${textoExtraido}"`;
        
        console.log("🧠 Enviando texto a la IA a través del balanceador...");
        
        const respuestaOllama = await fetch('http://nginx/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3.2', 
                prompt: promptOficina,
                stream: false
            })
        });
        
        const nodoQueTrabajo = respuestaOllama.headers.get('x-nodo-ia') || 'Desconocido';
        const datosIA = await respuestaOllama.json();

        console.log("💾 Guardando resultado en el historial...");
        const nuevoRegistro = {
            id: Date.now(),
            archivo_original: req.file.originalname,
            archivo_guardado: req.file.filename, 
            fecha: new Date().toISOString(),
            procesado_por: nodoQueTrabajo,
            resultado_ia: datosIA.response
        };

        const historialViejo = JSON.parse(fs.readFileSync(archivoHistorial));
        historialViejo.push(nuevoRegistro);
        fs.writeFileSync(archivoHistorial, JSON.stringify(historialViejo, null, 2));

        console.log(`✅ Análisis completado por el nodo: ${nodoQueTrabajo}`);
        res.json({
            mensaje: 'Documento procesado y guardado con éxito',
            registro: nuevoRegistro
        });

    } catch (error) {
        console.error("❌ Error en el proceso:", error);
        res.status(500).json({ error: 'Hubo un problema procesando el documento' });
    }
});

// ---------------------------------------------------------
// 🟢 INICIAR SERVIDOR
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en el puerto ${PORT}`);
});