import { detectChatGptConversation, emptyChatGptSetup, latestChatGptSetup, parseChatGptConversation } from './chatgpt.ts';
import { arrayItems } from './json-stream.ts';
import { looksLikeZip, openZipEntry, readZipDirectory } from './zip.ts';

/** Read only conversation files. Each conversation is dropped after its setup has been checked. */
export async function readChatGptSetup(file: { name: string; blob: Blob }, signal?: AbortSignal) {
  let newest = emptyChatGptSetup();
  async function read(stream: ReadableStream<Uint8Array>) {
    for await (const conversation of arrayItems(stream)) {
      signal?.throwIfAborted();
      if (detectChatGptConversation(conversation)) newest = latestChatGptSetup(newest, parseChatGptConversation(conversation));
    }
  }

  const { name, blob } = file;
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  signal?.throwIfAborted();
  if (/\.zip$/i.test(name) || looksLikeZip(head)) {
    for (const entry of await readZipDirectory(blob)) {
      signal?.throwIfAborted();
      if (!entry.directory && /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(entry.name))
        await read(await openZipEntry(blob, entry));
    }
  } else if (/^conversations(?:-\d+)?\.json$/i.test(name)) {
    await read(blob.stream() as ReadableStream<Uint8Array>);
  }
  signal?.throwIfAborted();
  return newest.setup;
}
