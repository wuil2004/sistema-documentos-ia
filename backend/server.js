const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-extraction'); // <-- La nueva librería salvadora
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Configurar multer para guardar el PDF temporalmente en la memoria RAM
const upload = multer({ storage: multer.memoryStorage() });

// Endpoint principal para recibir y procesar el documento
app.post('/api/analizar', upload.single('documento'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Por favor sube un archivo PDF' });
        }

        console.log("📄 Extrayendo texto del PDF...");
        // 1. Extraer el texto del buffer de memoria usando la nueva librería
        const pdfData = await pdfParse(req.file.buffer);
        const textoExtraido = pdfData.text;

        // 2. Preparar el prompt estricto para Llama 3.2
        const promptOficina = `Actúa como un asistente automático de oficina.
            Tu trabajo es leer el siguiente documento, generar un resumen de máximo 2 líneas y 
            clasificarlo con un nivel de prioridad usando estrictamente UNA de estas opciones: Rojo, 
            Ámbar o Verde.\n\nRegla de oro: NO des explicaciones adicionales, NO justifiques tu respuesta, 
            solo entrega el resumen y el color.\n\nDocumento: "${textoExtraido}"`;
        console.log("🧠 Enviando texto a la IA...");
        // 3. Pegarle a la API local de Ollama
        const respuestaOllama = await fetch('http://nginx/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3.2',
                prompt: promptOficina,
                stream: false
            })
        });
        // ¡NUEVO! Atrapamos la IP del nodo que Nginx nos mandó en secreto
        const nodoQueTrabajo = respuestaOllama.headers.get('x-nodo-ia') || 'Desconocido';

        const datosIA = await respuestaOllama.json();

        // 4. Devolver la respuesta al cliente
        console.log("✅ Análisis completado");
        res.json({
            mensaje: 'Documento procesado con éxito',
            procesado_por:nodoQueTrabajo,
            analisis_ia: datosIA.response
        });

    } catch (error) {
        console.error("❌ Error en el proceso:", error);
        res.status(500).json({ error: 'Hubo un problema procesando el documento' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en el puerto ${PORT}`);
});