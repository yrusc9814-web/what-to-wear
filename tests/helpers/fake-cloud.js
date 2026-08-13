function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createFakeCloud(seed = {}, openid = "user_123") {
  const collections = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, clone(rows)]));
  const options = arguments[2] || {};
  const autoRegisterCloudFiles = options.autoRegisterCloudFiles !== false;
  const cloudFiles = new Map();
  const metrics = {
    transactionCalls: 0,
    transactionCommits: 0,
    transactionRollbacks: 0,
    currentOpenIds: []
  };
  let currentOpenid = openid;
  let nextId = 1;
  let now = 2000000000000;
  const neq = (value) => ({ __op: "neq", value });
  const lt = (value) => ({ __op: "lt", value });
  const lte = (value) => ({ __op: "lte", value });
  const gt = (value) => ({ __op: "gt", value });
  const gte = (value) => ({ __op: "gte", value });
  const inOperator = (value) => ({ __op: "in", value });
  const or = (...conditions) => ({ __op: "or", conditions });
  const and = (...conditions) => ({ __op: "and", conditions });

  function matches(row, where) {
    if (where && where.__op === "or") return where.conditions.some((condition) => matches(row, condition));
    if (where && where.__op === "and") return where.conditions.every((condition) => matches(row, condition));
    return Object.entries(where || {}).every(([key, expected]) => {
      if (expected && expected.__op === "neq") return row[key] !== expected.value;
      if (expected && expected.__op === "lte") return row[key] <= expected.value;
      if (expected && expected.__op === "lt") return row[key] < expected.value;
      if (expected && expected.__op === "gte") return row[key] >= expected.value;
      if (expected && expected.__op === "gt") return row[key] > expected.value;
      if (expected && expected.__op === "in") return expected.value.includes(row[key]);
      if (expected && expected.__op === "or") return expected.conditions.some((condition) => matches(row, { [key]: condition }));
      return row[key] === expected;
    });
  }

  function collection(name) {
    if (!collections[name]) collections[name] = [];
    const rows = collections[name];

    function query(state = {}) {
      const config = { where: {}, order: [], skip: 0, limit: Infinity, ...state };
      return {
        where(where) { return query({ ...config, where }); },
        orderBy(field, direction) { return query({ ...config, order: [...config.order, [field, direction]] }); },
        skip(value) { return query({ ...config, skip: value }); },
        limit(value) { return query({ ...config, limit: value }); },
        async get() {
          let result = rows.filter((row) => matches(row, config.where));
          config.order.slice().reverse().forEach(([field, direction]) => {
            result.sort((left, right) => {
              const a = left[field] == null ? "" : left[field];
              const b = right[field] == null ? "" : right[field];
              const comparison = typeof a === "number" && typeof b === "number"
                ? a - b
                : String(a).localeCompare(String(b));
              return direction === "desc" ? -comparison : comparison;
            });
          });
          return { data: clone(result.slice(config.skip, config.skip + config.limit)) };
        },
        async update({ data }) {
          let updated = 0;
          rows.forEach((row, index) => {
            if (!matches(row, config.where)) return;
            rows[index] = { ...row, ...clone(data) };
            updated += 1;
          });
          return { stats: { updated } };
        }
      };
    }

    return {
      where(where) { return query().where(where); },
      orderBy(field, direction) { return query().orderBy(field, direction); },
      limit(value) { return query().limit(value); },
      async add({ data }) {
        const _id = `${name}_${nextId++}`;
        rows.push({ ...clone(data), _id });
        return { _id };
      },
      doc(id) {
        return {
          async get() {
            const row = rows.find((entry) => entry._id === id);
            return { data: row ? clone(row) : null };
          },
          async set({ data }) {
            const index = rows.findIndex((row) => row._id === id);
            const next = { ...clone(data), _id: id };
            if (index < 0) rows.push(next);
            else rows[index] = next;
            return { stats: { updated: 1 } };
          },
          async update({ data }) {
            const index = rows.findIndex((row) => row._id === id);
            if (index < 0) return { stats: { updated: 0 } };
            rows[index] = { ...rows[index], ...clone(data) };
            return { stats: { updated: 1 } };
          },
          async remove() {
            const index = rows.findIndex((row) => row._id === id);
            if (index < 0) return { stats: { removed: 0 } };
            rows.splice(index, 1);
            return { stats: { removed: 1 } };
          }
        };
      }
    };
  }

  function restore(snapshot) {
    const names = new Set([...Object.keys(collections), ...Object.keys(snapshot)]);
    names.forEach((name) => {
      if (!collections[name]) collections[name] = [];
      collections[name].splice(0, collections[name].length, ...(clone(snapshot[name] || [])));
    });
  }

  function transactionApi(snapshot) {
    let closed = false;
    return {
      get closed() { return closed; },
      collection,
      async commit() {
        if (closed) return {};
        closed = true;
        metrics.transactionCommits += 1;
        return {};
      },
      async rollback() {
        if (closed) return {};
        closed = true;
        restore(snapshot);
        metrics.transactionRollbacks += 1;
        return {};
      }
    };
  }

  const database = () => ({
    command: { neq, lt, lte, gt, gte, in: inOperator, or, and },
    serverDate() { now += 1; return now; },
    collection,
    async runTransaction(callback) {
      metrics.transactionCalls += 1;
      const snapshot = clone(collections);
      const transaction = transactionApi(snapshot);
      try {
        const result = await callback(transaction);
        if (!transaction.closed) await transaction.commit();
        return result;
      } catch (error) {
        if (!transaction.closed) await transaction.rollback();
        throw error;
      }
    },
    async startTransaction() {
      metrics.transactionCalls += 1;
      return transactionApi(clone(collections));
    }
  });

  function setCloudFile(fileId, value = {}) {
    cloudFiles.set(String(fileId), {
      accessible: value.accessible !== false,
      tempFileURL: value.tempFileURL || `https://fake-cloud.invalid/temp/${encodeURIComponent(fileId)}`
    });
  }

  function getTempFileURL({ fileList } = {}) {
    const list = Array.isArray(fileList) ? fileList : [];
    return Promise.resolve({
      fileList: list.map((entry) => {
        const fileID = String(typeof entry === "string" ? entry : entry && (entry.fileID || entry.fileId) || "");
        const known = cloudFiles.get(fileID);
        const accessible = known ? known.accessible : autoRegisterCloudFiles && /^cloud:\/\//.test(fileID);
        return accessible
          ? { fileID, code: "SUCCESS", tempFileURL: known && known.tempFileURL || `https://fake-cloud.invalid/temp/${encodeURIComponent(fileID)}` }
          : { fileID, code: "FILE_NOT_FOUND", tempFileURL: "" };
      })
    });
  }

  return {
    cloud: {
      DYNAMIC_CURRENT_ENV: "test",
      SYMBOL_CURRENT_ENV: "test",
      SYMBOL_DEFAULT_ENV: "test",
      init() {},
      getWXContext() {
        metrics.currentOpenIds.push(currentOpenid);
        return { OPENID: currentOpenid };
      },
      database,
      getTempFileURL
    },
    cloudbase: {
      SYMBOL_CURRENT_ENV: "test",
      SYMBOL_DEFAULT_ENV: "test",
      init() {
        return { database, getTempFileURL };
      }
    },
    collections,
    metrics,
    setCurrentOpenId(value) { currentOpenid = String(value || ""); },
    getCurrentOpenId() { return currentOpenid; },
    setCloudFile,
    registerCloudFile(fileId, value) { setCloudFile(fileId, value); }
  };
}

module.exports = { createFakeCloud };
