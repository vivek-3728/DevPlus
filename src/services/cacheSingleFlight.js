// A "single flight" lets concurrent requests share the same Promise. When
// several requests miss the same cache key at once, only the first performs
// the PostgreSQL work and the rest await its result.
const inFlightLoads = new Map();

const runSingleFlight = (key, load) => {
    const existingLoad = inFlightLoads.get(key);
    if (existingLoad) return existingLoad;

    const newLoad = Promise.resolve()
        .then(load)
        .finally(() => {
            // Delete only our own Promise. This guard prevents an older flight
            // from deleting a newer retry that happens to use the same key.
            if (inFlightLoads.get(key) === newLoad) {
                inFlightLoads.delete(key);
            }
        });

    inFlightLoads.set(key, newLoad);
    return newLoad;
};

module.exports = { runSingleFlight };
