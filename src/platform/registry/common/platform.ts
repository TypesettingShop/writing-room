const entries = new Map<string, object>();

export const Registry = {
  add(id: string, value: object): void {
    if (entries.has(id)) {
      throw new Error(`Registry already contains ${id}.`);
    }
    entries.set(id, value);
  },

  as<T>(id: string): T | null {
    return (entries.get(id) as T | undefined) ?? null;
  },

  knows(id: string): boolean {
    return entries.has(id);
  },
};
