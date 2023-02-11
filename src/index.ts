import {
  IncomingMessage,
  ServerResponse,
  request,
  createServer,
} from "node:http";

import { mkdirSync, statSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";

const crypto = require("node:crypto");

const cachedHeaders = new Set("session");

if (parseBooleanFlag("h", "help")) {
  console.log(`  -h, --help          print help
  -p, --port          run server on this port
  -P, --proxy-port    proxy to server on this port
  -s, --skip-cache    always forward requests to proxied server, overwriting any existing cache
  -d, --cache-dir     directory for cached responses`);
  process.exit();
}

const PORT = Number(parseFlag("p", "port", "1234"));
const PROXY_PORT = Number(parseFlag("P", "proxy-port", "7001"));
const SKIP_CACHE = parseBooleanFlag("s", "skip-cache");
const CACHE_DIR = parseFlag("d", "cache-dir", "cache");

type EncodedResponse = {
  statusCode: number;
  headers: string[];
  body: string;
};

function parseFlag(shortflag: string, longflag: string, defaultValue: string) {
  let index = process.argv.indexOf(`-${shortflag}`);
  if (index === -1) index = process.argv.indexOf(`--${longflag}`);
  if (index === -1) return defaultValue;
  return process.argv[index + 1];
}

function parseBooleanFlag(shortflag: string, longflag: string) {
  let index = process.argv.indexOf(`-${shortflag}`);
  if (index === -1) index = process.argv.indexOf(`--${longflag}`);
  if (index === -1) return false;
  return true;
}

function cacheFilename(hash: string, graphQLOperation: string | null) {
  return graphQLOperation ? `${graphQLOperation}_${hash}` : `${hash}`;
}

function hashRequest(req: IncomingMessage, data: Buffer) {
  const headerNames = Object.keys(req.headers).filter((h) =>
    cachedHeaders.has(h)
  );
  headerNames.sort();
  const headers = headerNames.map((h) => req.headers[h]).join("\n");
  return crypto
    .createHash("sha1")
    .update(
      Buffer.concat([Buffer.from(req.method ?? "" + req.url + headers), data])
    )
    .digest("base64url");
}

async function saveResponse(
  hash: string,
  encoded: EncodedResponse,
  graphQLOperation: string | null
) {
  await writeFile(
    `${CACHE_DIR}/${cacheFilename(hash, graphQLOperation)}`,
    JSON.stringify(encoded)
  );
}

async function getCachedResponse(
  hash: string,
  graphQLOperation: string | null
) {
  try {
    const data = await readFile(
      `${CACHE_DIR}/${cacheFilename(hash, graphQLOperation)}`
    );
    return JSON.parse(data.toString());
  } catch (err) {
    return null;
  }
}

async function forwardRequest(
  origReq: IncomingMessage,
  data: Buffer
): Promise<EncodedResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: origReq.method,
        host: "127.0.0.1",
        port: PROXY_PORT,
        path: origReq.url,
        headers: origReq.headers,
      },
      (res) => {
        const buf: Buffer[] = [];
        res.on("data", (chunk) => {
          buf.push(chunk);
        });
        res.on("end", () => {
          resolve({
            headers: res.rawHeaders,
            statusCode: res.statusCode ?? 200,
            body: Buffer.concat(buf).toString(),
          });
        });
        res.on("error", (err) => {
          reject(err);
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });
    req.write(data);
    req.end();
  });
}

async function replayOrForward(req: IncomingMessage, data: Buffer) {
  const graphQLOperation = req.url?.startsWith("/graphql")
    ? JSON.parse(data.toString()).operationName
    : null;
  const hash = hashRequest(req, data);

  let encoded: EncodedResponse | null = null;
  if (!SKIP_CACHE) {
    encoded = await getCachedResponse(hash, graphQLOperation);
    if (encoded) {
      console.log(`cached ${cacheFilename(hash, graphQLOperation)}`);
    }
  }
  if (!encoded) {
    try {
      console.log(`proxying ${cacheFilename(hash, graphQLOperation)}`);
      encoded = await forwardRequest(req, data);
      await saveResponse(hash, encoded!, graphQLOperation);
    } catch {
      console.log(`proxy error ${cacheFilename(hash, graphQLOperation)}`);
      encoded = {
        statusCode: 502,
        headers: ["content-type", "application/json"],
        body: `{"errors":[{"message":"Unable to reach server on ${PROXY_PORT} for ${
          req.method
        } ${req.url} ${
          graphQLOperation || ""
        }","extensions":{"code":"BAD_GATEWAY"}}]}`,
      };
    }
  }
  return encoded;
}

function serve(req: IncomingMessage, res: ServerResponse) {
  const requestBody: Buffer[] = [];
  req.on("data", (chunk) => {
    requestBody.push(chunk);
  });
  req.on("end", async () => {
    const data = Buffer.concat(requestBody);

    const encoded = await replayOrForward(req, data);
    res.statusCode = encoded.statusCode;
    for (let i = 0; i < encoded.headers.length - 1; i += 2) {
      res.setHeader(encoded.headers[i], encoded.headers[i + 1]);
    }
    res.end(encoded.body);
  });
  req.on("error", (err) => {
    throw err;
  });
}

if (!statSync(CACHE_DIR, { throwIfNoEntry: false })) mkdirSync(CACHE_DIR);

const server = createServer(serve);
server.listen(PORT, "127.0.0.1");
console.log(
  `proxying from ${PORT} to ${PROXY_PORT}${SKIP_CACHE ? " skipping cache" : ""}`
);
