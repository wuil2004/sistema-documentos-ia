const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-extraction');
const cors = require('cors');
const fs = require('fs');     // Para manejar archivos físicos
const path = require('path'); // Para manejar rutas de carpetas

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 💾 CONFIGURACIÓN DE ALMACENAMIENTO (PERSISTENCIA)
// ---------------------------------------------------------
const carpetaDocs = path.join(__dirname, 'documentos_guardados');
const archivoHistorial = path.join(__dirname, 'historial.json');

// Si la carpeta de documentos no existe, la creamos automáticamente
if (!fs.existsSync(carpetaDocs)) {
    fs.mkdirSync(carpetaDocs);
}

// Si el archivo del historial no existe, lo creamos vacío (con un arreglo)
if (!fs.existsSync(archivoHistorial)) {
    fs.writeFileSync(archivoHistorial, JSON.stringify([]));
}

// Le decimos a Multer que guarde en el disco duro y no en la RAM
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, carpetaDocs);
    },
    filename: (req, file, cb) => {
        // Agregamos un timestamp para que no se sobreescriban archivos con el mismo nombre
        cb(null, Date.now() + '_' + file.originalname);
    }
});
const upload = multer({ storage: storage });


// ---------------------------------------------------------
// 🚀 ENDPOINT PRINCIPAL: SUBIR Y ANALIZAR DOCUMENTO
// ---------------------------------------------------------
app.post('/api/analizar', upload.single('documento'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Por favor sube un archivo PDF' });
        }

        console.log(`\n📥 Recibido: ${req.file.originalname}`);
        console.log("📄 Extrayendo texto del PDF desde el disco duro...");
        
        // 1. Ahora leemos el archivo físico que se acaba de guardar
        const pdfBuffer = fs.readFileSync(req.file.path); 
        const pdfData = await pdfParse(pdfBuffer);
        const textoExtraido = pdfData.text;

        // 2. Preparar el prompt estricto para Llama 3.2
        const promptOficina = `Actúa como un asistente automático de oficina.
            Tu trabajo es leer el siguiente documento, generar un resumen de máximo 2 líneas y 
            clasificarlo con un nivel de prioridad usando estrictamente UNA de estas opciones: Rojo, 
            Ámbar o Verde.\n\nRegla de oro: NO des explicaciones adicionales, NO justifiques tu respuesta, 
            solo entrega el resumen y el color.\n\nDocumento: "${textoExtraido}"`;
        
        console.log("🧠 Enviando texto a la IA a través del balanceador...");
        
        // 3. Pegarle a la API local de Ollama a través de Nginx
        const respuestaOllama = await fetch('http://nginx/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3.2', // Cambia a llama3.2:1b si deciden usar el modelo rápido
                prompt: promptOficina,
                stream: false
            })
        });
        
        // Atrapamos la IP del nodo físico que Nginx nos mandó en secreto
        const nodoQueTrabajo = respuestaOllama.headers.get('x-nodo-ia') || 'Desconocido';
        const datosIA = await respuestaOllama.json();

        // 4. GUARDAR EN EL HISTORIAL
        console.log("💾 Guardando resultado en el historial...");
        const nuevoRegistro = {
            id: Date.now(),
            archivo_original: req.file.originalname,
            archivo_guardado: req.file.filename, // Nombre físico en la carpeta
            fecha: new Date().toISOString(),
            procesado_por: nodoQueTrabajo,
            resultado_ia: datosIA.response
        };

        // Leemos el historial viejo, inyectamos el nuevo registro, y reescribimos el archivo
        const historialViejo = JSON.parse(fs.readFileSync(archivoHistorial));
        historialViejo.push(nuevoRegistro);
        fs.writeFileSync(archivoHistorial, JSON.stringify(historialViejo, null, 2));

        // 5. Devolver la respuesta al cliente (Insomnia/Frontend)
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