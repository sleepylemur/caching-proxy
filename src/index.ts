import {
  IncomingMessage,
  ServerResponse,
  request,
  createServer,
} from "node:http";

import { writeFile, readFile, mkdirSync, statSync } from "node:fs";

const crypto = require("node:crypto");

const cachedHeaders = new Set("session");

const PORT = Number(parseFlag("p", "port", "1234"));
const PROXY_PORT = Number(parseFlag("P", "proxy-port", "7001"));
const SKIP_CACHE = parseBooleanFlag("s", "skip-cache");

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

function saveResponse(
  hash: string,
  encoded: EncodedResponse,
  graphQLOperation: string | null
) {
  const filename = graphQLOperation
    ? `cached/${graphQLOperation}_${hash}`
    : `cached/${hash}`;
  writeFile(filename, JSON.stringify(encoded), (err) => {
    if (err) throw err;
  });
}

function getCachedResponse(
  hash: string,
  graphQLOperation: string | null,
  cb: (encoded: EncodedResponse | null) => void
) {
  const filename = graphQLOperation
    ? `cached/${graphQLOperation}_${hash}`
    : `cached/${hash}`;
  readFile(filename, (err, filedata) => {
    if (err) cb(null);
    else cb(JSON.parse(filedata.toString()));
  });
}

function forwardRequest(
  origReq: IncomingMessage,
  data: Buffer,
  cb: (err: Error | null, encoded?: EncodedResponse) => void
) {
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
        cb(null, {
          headers: res.rawHeaders,
          statusCode: res.statusCode ?? 200,
          body: Buffer.concat(buf).toString(),
        });
      });
      res.on("error", (err) => {
        cb(err);
      });
    }
  );

  req.on("error", (err) => {
    cb(err);
  });
  req.write(data);
  req.end();
}

function replayOrForward(
  req: IncomingMessage,
  data: Buffer,
  cb: (encoded: EncodedResponse) => void
) {
  const graphQLOperation = req.url?.startsWith("/graphql")
    ? JSON.parse(data.toString()).operationName
    : null;
  const hash = hashRequest(req, data);

  const forward = () => {
    forwardRequest(req, data, (forwardErr, encoded) => {
      if (forwardErr || !encoded) {
        cb({
          statusCode: 502,
          headers: ["content-type", "application/json"],
          body: `{"errors":[{"message":"Unable to reach server on ${PROXY_PORT} for ${
            req.method
          } ${req.url} ${
            graphQLOperation || ""
          }","extensions":{"code":"BAD_GATEWAY"}}]}`,
        });
      } else {
        saveResponse(hash, encoded, graphQLOperation);
        cb(encoded);
      }
    });
  };

  if (SKIP_CACHE) {
    forward();
  } else {
    getCachedResponse(hash, graphQLOperation, (encoded) => {
      if (!encoded) forward();
      else cb(encoded);
    });
  }
}

function serve(req: IncomingMessage, res: ServerResponse) {
  const requestBody: Buffer[] = [];
  req.on("data", (chunk) => {
    requestBody.push(chunk);
  });
  req.on("end", () => {
    const data = Buffer.concat(requestBody);

    replayOrForward(req, data, (encoded) => {
      res.statusCode = encoded.statusCode;
      for (let i = 0; i < encoded.headers.length - 1; i += 2) {
        res.setHeader(encoded.headers[i], encoded.headers[i + 1]);
      }
      res.end(encoded.body);
    });
  });
  req.on("error", (err) => {
    throw err;
  });
}

if (!statSync("cached", { throwIfNoEntry: false })) mkdirSync("cached");
const server = createServer(serve);
server.listen(PORT, "127.0.0.1");
console.log(
  `proxying from ${PORT} to ${PROXY_PORT}${SKIP_CACHE ? " skipping cache" : ""}`
);
