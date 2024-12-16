import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { Database } from "bun:sqlite";
import { writeFile, unlink, stat, mkdir, rmdir, readdir } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import { cpus } from "os";
import { EventEmitter } from "events";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

const app = new Hono();
const PORT = 3000;

// Middleware to handle CORS
app.use((c, next) => {
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") {
    return c.text("", 204);
  }
  return next();
});

const uploadDir = "temp_chunks";
const uploadsDir = "uploads";

const MAX_WORKERS = cpus().length;
const workerPool = [];

// Increase the maximum number of listeners
EventEmitter.defaultMaxListeners = 100;

// Initialize worker pool
for (let i = 0; i < MAX_WORKERS; i++) {
  const worker = new Worker(
    `
    import { parentPort } from 'worker_threads';
    import { writeFile } from 'fs/promises';
    import path from 'path';

    parentPort.on('message', async ({ chunk, chunkPath }) => {
      try {
        await writeFile(chunkPath, chunk);
        parentPort.postMessage({ success: true, chunkPath });
      } catch (error) {
        parentPort.postMessage({ success: false, error: error.message });
      }
    });
  `,
    { eval: true }
  );

  workerPool.push(worker);
}

let currentWorker = 0;

function getNextWorker() {
  const worker = workerPool[currentWorker];
  currentWorker = (currentWorker + 1) % MAX_WORKERS;
  return worker;
}

// Create necessary directories if they don't exist
try {
  await mkdir(uploadDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
} catch (error) {
  if (error.code !== "EEXIST") {
    console.error("Error creating directories:", error);
  }
}

app.use("/*", serveStatic({ root: "./public" }));

// Serve static files from the uploads directory at the root path
app.use(serveStatic({ root: uploadsDir }));

let db = new Database("chunks.db");
db.exec(`
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

const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", (ws) => {
  console.log("WebSocket connection established");
});

app.post("/upload", async (c) => {
  const formData = await c.req.parseBody();
  const file = formData.chunk;

  if (!file) {
    return c.json({ message: "No file uploaded" }, 400);
  }

  const fileId = uuidv4();
  const { fileName, chunkIndex, totalChunks } = formData;
  const fileDir = path.join(uploadDir, fileId);
  const filename = `${chunkIndex}-${file.name}`;
  const chunkPath = path.join(fileDir, filename);

  try {
    // Create directory for the file if it doesn't exist
    await mkdir(fileDir, { recursive: true });

    // Use a worker to write the chunk
    const worker = getNextWorker();
    const chunk = new Uint8Array(await file.arrayBuffer());

    await new Promise((resolve, reject) => {
      worker.postMessage({ chunk, chunkPath });

      worker.once("message", (result) => {
        if (result.success) {
          resolve();
        } else {
          reject(new Error(result.error));
        }
      });
    });

    // Insert chunk info into database
    db.prepare(
      `
      INSERT INTO chunks (fileId, originalname, chunkIndex, totalChunks, filename)
      VALUES (?, ?, ?, ?, ?)
    `
    ).run(fileId, fileName, chunkIndex, totalChunks, filename);

    const count = db
      .prepare(
        `
      SELECT COUNT(*) as count FROM chunks WHERE fileId = ? AND totalChunks = ?
    `
      )
      .get(fileId, totalChunks);

    if (parseInt(count.count) === parseInt(totalChunks)) {
      // Defer combination to a background process
      setImmediate(async () => {
        try {
          const outputPath = path.join(
            process.cwd(),
            "uploads",
            `${fileId}_${fileName}`
          );

          await combineChunks(fileId, outputPath);

          const fileStats = await stat(outputPath);
          db.prepare(
            `
          INSERT INTO files (id, originalname, fileSize, fileType)
          VALUES (?, ?, ?, ?)
        `
          ).run(fileId, fileName, fileStats.size, file.type);

          await deleteChunks(fileId);

          console.log(`File ${fileName} combined and saved successfully`);
        } catch (error) {
          console.error("Error combining chunks:", error);
          // Clean up any partial uploads
          await deleteChunks(fileId);
        }
      });

      return c.json({
        message: "All chunks uploaded, combining in background",
      });
    } else {
      // Send progress update via WebSocket
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({
              type: "progress",
              fileId: fileId,
              progress: (parseInt(count.count) / totalChunks) * 100,
            })
          );
        }
      });

      return c.json({ message: "Chunk received" });
    }
  } catch (error) {
    console.error("Error processing chunk:", error);
    return c.json({ message: "Error processing chunk" }, 500);
  }
});

async function combineChunks(fileId, outputPath) {
  const fileDir = path.join(uploadDir, fileId);
  const chunks = db
    .prepare(`SELECT filename FROM chunks WHERE fileId = ? ORDER BY chunkIndex`)
    .all(fileId);

  const writeStream = createWriteStream(outputPath);

  try {
    for (const chunk of chunks) {
      const chunkPath = path.join(fileDir, chunk.filename);

      // Check if chunk exists before trying to read it
      try {
        await stat(chunkPath);
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new Error(`Chunk file not found: ${chunkPath}`);
        }
        throw error;
      }

      await new Promise((resolve, reject) => {
        const readStream = createReadStream(chunkPath);

        readStream.on("error", (error) => {
          readStream.destroy();
          writeStream.destroy();
          reject(error);
        });

        writeStream.on("error", (error) => {
          readStream.destroy();
          writeStream.destroy();
          reject(error);
        });

        readStream.pipe(writeStream, { end: false });
        readStream.on("end", resolve);
      });
    }

    // Close the write stream properly
    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on("finish", () => {
        console.log("File combination complete");
        resolve();
      });
      writeStream.on("error", reject);
    });
  } catch (error) {
    // Clean up in case of error
    writeStream.destroy();
    throw error;
  }
}

async function deleteChunks(fileId) {
  const fileDir = path.join(uploadDir, fileId);
  const chunks = db
    .prepare(
      `
    SELECT filename FROM chunks WHERE fileId = ?
  `
    )
    .all(fileId);

  for (const chunk of chunks) {
    const chunkPath = path.join(fileDir, chunk.filename);
    try {
      await unlink(chunkPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Error deleting chunk file ${chunkPath}:`, error);
      }
    }
  }

  // Remove the directory after deleting all chunks
  try {
    await rmdir(fileDir);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Error deleting directory ${fileDir}:`, error);
    }
  }

  db.prepare(`DELETE FROM chunks WHERE fileId = ?`).run(fileId);
}

// app.get("/files", async (c) => {
//   try {
//     const files = db
//       .prepare("SELECT * FROM files ORDER BY uploadedAt DESC")
//       .all();
//       console.log(c.json(files),"files")
//     return c.json(files);
//   } catch (error) {
//     console.error("Error fetching files:", error);
//     return c.json({ message: "Error fetching files" }, 500);
//   }
// });

app.get("/files", async (c) => {
  try {
    // Check if uploads directory exists
    const dirExists = await stat(uploadsDir).catch(() => false);
    if (!dirExists) {
      return c.json({ message: "Uploads directory does not exist" }, 404);
    }

    const files = await readdir(uploadsDir);
    console.log("Files in uploads directory:", files); // Log the files

    const fileDetails = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(uploadsDir, file);
        const fileStats = await stat(filePath);
        return {
          originalname: file,
          fileSize: fileStats.size,
          createdAt: fileStats.birthtime,
          fileType: "",
          id: uuidv4(),
        };
      })
    );

    return c.json(fileDetails);
  } catch (error) {
    console.error("Error fetching files:", error);
    return c.json({ message: "Error fetching files" }, 500);
  }
});

app.get("/", (c) => {
  return c.html(Bun.file("public/index.html"));
});

console.log(`Server starting on port ${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
