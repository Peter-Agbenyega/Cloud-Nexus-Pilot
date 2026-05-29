export function buildAiJobDedupKey(productId, jobType, windowDate = new Date()) {
    const dayBucket = windowDate.toISOString().slice(0, 10);
    return `${productId}:${jobType}:${dayBucket}`;
}
//# sourceMappingURL=queue.js.map