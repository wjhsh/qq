// Bound slow browser connections without retaining session history in another queue.
export const MAX_SSE_CLIENTS = 8;
export const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

function remove(clients, response) {
  clients.delete(response);
  try { response.destroy(); } catch { /* close/error handlers finish cleanup */ }
}

export function hasEventReaders(clients) {
  for (const response of clients) {
    if (response.destroyed || response.writableEnded) clients.delete(response);
  }
  return clients.size > 0;
}

export function writeEventFrame(clients, line, maxBufferedBytes = MAX_SSE_BUFFER_BYTES) {
  for (const response of clients) {
    if (response.destroyed || response.writableEnded) { clients.delete(response); continue; }
    if (response.writableLength > maxBufferedBytes) { remove(clients, response); continue; }
    try {
      response.write(line);
      if (response.writableLength > maxBufferedBytes) remove(clients, response);
    } catch { remove(clients, response); }
  }
}
