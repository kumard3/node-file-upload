self.onmessage = async function (event) {
  const { fileId, fileName, chunk, chunkIndex, totalChunks, serverUrl } = event.data;
  const MAX_RETRIES = 3;
  let attempt = 0;

  const formData = new FormData();
  formData.append("fileId", fileId);
  formData.append("fileName", fileName);
  formData.append("chunkIndex", chunkIndex);
  formData.append("totalChunks", totalChunks);
  formData.append("chunk", chunk);

  while (attempt < MAX_RETRIES) {
    try {
      const response = await fetch(`${serverUrl}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      self.postMessage({ success: true, chunkIndex });
      return;
    } catch (error) {
      console.error(`Error uploading chunk ${chunkIndex}: ${error.message}`);
      attempt++;
      if (attempt >= MAX_RETRIES) {
        self.postMessage({ success: false, chunkIndex, error: error.message });
      } else {
        console.log(`Retrying chunk ${chunkIndex} (Attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
      }
    }
  }
}; 