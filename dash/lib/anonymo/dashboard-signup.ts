// A random ID scopes the dashboard's first chat to this browser. Only key creation sends it.
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const temporary = new Map<string, string>();

export function forgetSignupMemory() { temporary.clear(); }

export async function dashboardSignup(demo: boolean): Promise<string> {
  const slot = demo ? 'anonymo.demo.dashboard-signup' : 'anonymo.dashboard-signup';
  function readOrCreate() {
    try {
      const existing = localStorage.getItem(slot);
      if (existing && uuidV4.test(existing)) return existing;
      const id = temporary.get(slot) ?? crypto.randomUUID();
      localStorage.setItem(slot, id);
      temporary.delete(slot);
      return id;
    } catch {
      const id = temporary.get(slot) ?? crypto.randomUUID();
      temporary.set(slot, id);
      return id;
    }
  }
  // Two tabs creating their first key together must read the same ID.
  try { if (navigator.locks) return await navigator.locks.request(slot, readOrCreate); } catch { /* Locks can be disabled. */ }
  return readOrCreate();
}
