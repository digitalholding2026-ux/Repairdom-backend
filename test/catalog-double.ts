/* M1 — double Prisma du catalogue v2, en mémoire mais FIDÈLE.

 * Ses upsert écrivent réellement dans les tableaux et respectent la contrainte
 * unique naturelle du document ; ses findMany/findUnique/findFirst appliquent
 * le `where` — y compris `{ not: null }` et `{ in: [...] }`, les deux formes
 * que la règle de visibilité utilise — et l'`orderBy`. Le seed officiel est
 * déroulé sur ce double pour produire les fixtures : si le barème change, les
 * tests bougent avec lui au lieu de réciter d'anciennes valeurs.

 * Hors de `src/` : il n'a rien à faire dans le bundle applicatif, et Vitest ne
 * collecte que les fichiers `*.spec.ts`. */

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('not' in condition) return value !== condition.not;
      if ('in' in condition) return (condition.in as unknown[]).includes(value);
    }
    return value === condition;
  });
}

function sortRows(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0] as [string, string];
  return [...rows].sort((left, right) => {
    if (left[field] === right[field]) return 0;
    const step = left[field] < right[field] ? -1 : 1;
    return dir === 'desc' ? -step : step;
  });
}

export function createCatalogDouble() {
  const services: Row[] = [];
  const categories: Row[] = [];
  const items: Row[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const client = {
    service: {
      upsert: async ({ where, update, create }: any): Promise<Row> => {
        const found = services.find((row) => row.code === where.code);
        if (found) return Object.assign(found, update);
        const row: Row = { id: nextId('svc'), active: true, createdAt: new Date(seq), ...create };
        services.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) =>
        sortRows(services.filter((row) => matches(row, where ?? {})), orderBy),
      findUnique: async ({ where }: any) =>
        services.find((row) => row.id === where.id || row.code === where.code) ?? null,
    },
    catalogCategory: {
      upsert: async ({ where, update, create }: any): Promise<Row> => {
        const { serviceId, code } = where.serviceId_code;
        const found = categories.find((row) => row.serviceId === serviceId && row.code === code);
        if (found) return Object.assign(found, update);
        const row: Row = { id: nextId('cat'), active: true, ...create };
        categories.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) =>
        sortRows(categories.filter((row) => matches(row, where ?? {})), orderBy),
      findFirst: async ({ where }: any) => categories.find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where }: any) => categories.find((row) => row.id === where.id) ?? null,
    },
    catalogItem: {
      upsert: async ({ where, update, create }: any): Promise<Row> => {
        const { categoryId, code } = where.categoryId_code;
        const found = items.find((row) => row.categoryId === categoryId && row.code === code);
        if (found) return Object.assign(found, update);
        const row: Row = { id: nextId('item'), order: 0, ...create };
        items.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) =>
        sortRows(items.filter((row) => matches(row, where ?? {})), orderBy),
      findFirst: async ({ where }: any) => items.find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where }: any) => items.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: any): Promise<Row> => {
        const row: Row = { id: nextId('item'), order: 0, active: true, ...data };
        items.push(row);
        return row;
      },
      update: async ({ where, data }: any): Promise<Row> => {
        const row = items.find((entry) => entry.id === where.id);
        if (!row) throw new Error(`Item ${where.id} absent du double`);
        return Object.assign(row, data);
      },
    },
  };

  return { client: client as never, stores: { services, categories, items } };
}
