// JSON helpers and the error envelope the clients expect,
// {"error": {"code", "message", "field"?}}, from greenscreen, so its screen
// engine and the REST API answer errors alike.

export { errorResponse, HttpError, int, json, noContent, readJSON, str, type ErrorCode } from "@greenscreen-dev/worker";
