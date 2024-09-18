const cluster = require("cluster");
const numCPUs = require("os").cpus().length;
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const EventEmitter = require("events");

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`);
    // Replace the dead worker
    cluster.fork();
  });
} else {
  // Workers can share any TCP connection
  // In this case it is an HTTP server
  const app = express();
  const upload = multer({ dest: "temp_chunks/" });

  app.use(cors());
  app.use(express.json());
  app.use(express.static("uploads")); // Serve uploaded files

  let db;

  (async () => {
    db = await open({
      filename: "chunks.db",
      driver: sqlite3.Database,
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fileId TEXT,
        originalname TEXT,
        chunkIndex INTEGER,
        totalChunks INTEGER,
        filename TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        originalname TEXT,
        fileSize INTEGER,
        fileType TEXT,
        uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  })();

  const uploadProgress = new EventEmitter();

  app.get("/upload-progress", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendProgress = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    uploadProgress.on("progress", sendProgress);

    req.on("close", () => {
      uploadProgress.removeListener("progress", sendProgress);
    });
  });

  app.post("/upload", upload.single("chunk"), async (req, res) => {
    console.log("Received upload request");
    console.log("Request body:", req.body);
    console.log("Request file:", req.file);

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const { originalname, filename } = req.file;
    const { fileId, chunkMetadata, totalChunks, fileSize, fileType } = req.body;
    const parsedChunkMetadata = JSON.parse(chunkMetadata);
    const { chunkIndex } = parsedChunkMetadata;

    console.log(
      `Processing chunk ${chunkIndex} of ${totalChunks} for file: ${originalname} (FileID: ${fileId})`
    );

    try {
      await db.run(
        `INSERT INTO chunks (fileId, originalname, chunkIndex, totalChunks, filename, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
        [
          fileId,
          originalname,
          chunkIndex,
          totalChunks,
          filename,
          JSON.stringify({ fileSize, fileType, ...parsedChunkMetadata }),
        ]
      );

      const [{ count }] = await db.all(
        `SELECT COUNT(*) as count FROM chunks WHERE fileId = ? AND totalChunks = ?`,
        [fileId, totalChunks]
      );

      uploadProgress.emit("progress", {
        fileId,
        filename: originalname,
        progress: Math.round((count / totalChunks) * 100),
      });

      if (parseInt(count) === parseInt(totalChunks)) {
        console.log(`All chunks received for ${originalname}. Combining file.`);
        const outputPath = path.join(
          __dirname,
          "uploads",
          `${fileId}_${originalname}`
        );

        await combineChunks(fileId, outputPath);
        console.log(`File combined and saved to: ${outputPath}`);

        // Save file metadata to the database
        await db.run(
          `INSERT INTO files (id, originalname, fileSize, fileType) VALUES (?, ?, ?, ?)`,
          [fileId, originalname, fileSize, fileType]
        );

        // Delete all chunk files and database entries
        await deleteChunks(fileId);

        res.json({
          message: "File uploaded, combined, and metadata saved successfully",
          fileId: fileId,
        });
      } else {
        console.log(`Chunk ${chunkIndex} received for ${originalname}`);
        res.json({ message: "Chunk received" });
      }
    } catch (error) {
      console.error("Error processing chunk:", error);
      res.status(500).json({ message: "Error processing chunk" });
    }
    // Remove the finally block that was here
  });

  async function combineChunks(fileId, outputPath) {
    const writeStream = fs.createWriteStream(outputPath);

    const chunks = await db.all(
      `SELECT filename, metadata FROM chunks WHERE fileId = ? ORDER BY chunkIndex`,
      [fileId]
    );

    for (const chunk of chunks) {
      const chunkPath = path.join(__dirname, "temp_chunks", chunk.filename);
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        readStream.on("error", reject);
        readStream.pipe(writeStream, { end: false });
        readStream.on("end", resolve);
      });
    }

    return new Promise((resolve, reject) => {
      writeStream.on("finish", () => {
        console.log("File combination complete");
        resolve();
      });
      writeStream.on("error", reject);
      writeStream.end();
    });
  }

  async function deleteChunks(fileId) {
    const chunks = await db.all(
      `SELECT filename FROM chunks WHERE fileId = ?`,
      [fileId]
    );

    for (const chunk of chunks) {
      const chunkPath = path.join(__dirname, "temp_chunks", chunk.filename);
      try {
        await fsPromises.unlink(chunkPath);
        console.log(`Removed chunk file: ${chunkPath}`);
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error(`Error deleting chunk file ${chunkPath}:`, error);
        }
      }
    }

    await db.run(`DELETE FROM chunks WHERE fileId = ?`, [fileId]);
    console.log(`Cleared chunk data for fileId: ${fileId}`);
  }

  app.get("/files", async (req, res) => {
    try {
      const files = await db.all(
        "SELECT * FROM files ORDER BY uploadedAt DESC"
      );
      res.json(files);
    } catch (error) {
      console.error("Error fetching files:", error);
      res.status(500).json({ message: "Error fetching files" });
    }
  });

  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
  });

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Worker ${process.pid} is listening on port ${PORT}`);
  });
}
