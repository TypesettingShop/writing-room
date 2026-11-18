export async function readResponseText(response: Response, limit: number): Promise<string> {
  const tooLarge = () => new Error(`Response exceeds ${limit} bytes.`);
  if (Number(response.headers.get('Content-Length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        chunks.push(decoder.decode());
        return chunks.join('');
      }
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}
