// @kitepon/login-billing 0.16.0 login-billing-home-guard.mjs

// dist/home/guard.js
async function guard(set, headers) {
  if (!set || set.v !== 1 || typeof set.hashes !== "object")
    return { cannotJudge: true };
  const auth = headers["authorization"] ?? headers["Authorization"];
  if (!auth || !/^bearer /i.test(auth))
    return { none: true };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.slice(7).trim())));
  const th = Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
  const id = Object.hasOwn(set.hashes, th) ? set.hashes[th] : void 0;
  return id ? { sessionId: id } : { none: true };
}
export {
  guard
};
