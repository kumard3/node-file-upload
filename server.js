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

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  const app = express();
  const upload = multer({ dest: "temp_chunks/" });
  app.use(express.static("./public"));
  app.use(cors());
  app.use(express.json());
  app.use(express.static("uploads"));
  app.use(express.static("public"));

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

  app.post("/upload", upload.single("chunk"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const { fileId, fileName, chunkIndex, totalChunks } = req.body;
    const { originalname, filename } = req.file;

    try {
      await db.run(
        `INSERT INTO chunks (fileId, originalname, chunkIndex, totalChunks, filename)
                 VALUES (?, ?, ?, ?, ?)`,
        [fileId, fileName, chunkIndex, totalChunks, filename]
      );

      const [{ count }] = await db.all(
        `SELECT COUNT(*) as count FROM chunks WHERE fileId = ? AND totalChunks = ?`,
        [fileId, totalChunks]
      );

      if (parseInt(count) === parseInt(totalChunks)) {
        const outputPath = path.join(
          __dirname,
          "uploads",
          `${fileId}_${fileName}`
        );

        await combineChunks(fileId, outputPath);

        const fileStats = await fsPromises.stat(outputPath);
        await db.run(
          `INSERT INTO files (id, originalname, fileSize, fileType) VALUES (?, ?, ?, ?)`,
          [fileId, fileName, fileStats.size, req.file.mimetype]
        );

        await deleteChunks(fileId);

        res.json({
          message: "File uploaded, combined, and metadata saved successfully",
          fileId: fileId,
        });
      } else {
        res.json({ message: "Chunk received" });
      }
    } catch (error) {
      console.error("Error processing chunk:", error);
      res.status(500).json({ message: "Error processing chunk" });
    }
  });

  async function combineChunks(fileId, outputPath) {
    const writeStream = fs.createWriteStream(outputPath);

    const chunks = await db.all(
      `SELECT filename FROM chunks WHERE fileId = ? ORDER BY chunkIndex`,
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
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error(`Error deleting chunk file ${chunkPath}:`, error);
        }
      }
    }

    await db.run(`DELETE FROM chunks WHERE fileId = ?`, [fileId]);
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
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Worker ${process.pid} is listening on port ${PORT}`);
  });
}
