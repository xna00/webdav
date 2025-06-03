import fs from "fs/promises";
import http from "http";
import crypto from "crypto";
import fsSync from "fs";
import path from "path";

const PORT = 8080;
const ROOT_DIR = path.join(import.meta.dirname, "webdav-data");
const CREDENTIALS = { admin: "password" }; // 用户名:密码

fs.mkdir(ROOT_DIR, { recursive: true }).catch((err) => {
  console.error("无法创建数据目录:", err);
});

function getFileSystemPath(reqPath) {
  const parsedUrl = new URL(reqPath, "http://localhost");
  const cleanPath = path
    .normalize(decodeURI(parsedUrl.pathname))
    .replace(/^(\.\.[\/\\])+/, "");
  return path.join(ROOT_DIR, cleanPath);
}

// 辅助函数：检查路径是否在根目录内
function isPathInRoot(fsPath) {
  return fsPath.startsWith(ROOT_DIR);
}

// 辅助函数：生成ETag
function generateETag(stats) {
  const content = `${stats.mtime.getTime()}-${stats.size}`;
  return crypto.createHash("md5").update(content).digest("hex");
}

// 辅助函数：认证检查
function authenticate(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="WebDAV Server"' });
    res.end("认证失败");
    return false;
  }

  const [type, credentials] = authHeader.split(" ");
  if (type !== "Basic") {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="WebDAV Server"' });
    res.end("仅支持Basic认证");
    return false;
  }

  const [username, password] = Buffer.from(credentials, "base64")
    .toString()
    .split(":");
  if (!CREDENTIALS[username] || CREDENTIALS[username] !== password) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="WebDAV Server"' });
    res.end("用户名或密码错误");
    return false;
  }

  return true;
}

// 辅助函数：生成目录列表HTML
function generateDirectoryListing(fsPath, reqPath) {
  return fs
    .readdir(fsPath)
    .then((files) => {
      const entries = files.map((file) => {
        const entryPath = path.join(fsPath, file);
        return fs.stat(entryPath).then((stats) => ({
          name: file,
          isDirectory: stats.isDirectory(),
          size: stats.size,
          mtime: stats.mtime,
        }));
      });

      return Promise.all(entries);
    })
    .then((entries) => {
      let html = `
        <html>
        <head>
          <title>目录内容: ${reqPath}</title>
          <style>
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 8px; border: 1px solid #ddd; text-align: left; }
            th { background-color: #f2f2f2; }
            tr:hover { background-color: #f5f5f5; }
            .dir { font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>目录内容: ${reqPath}</h1>
          <table>
            <tr>
              <th>名称</th>
              <th>大小</th>
              <th>修改时间</th>
            </tr>
            <tr>
              <td><a href="${
                reqPath === "/" ? "/" : path.dirname(reqPath) + "/"
              }">..</a></td>
              <td>-</td>
              <td>-</td>
            </tr>
      `;

      entries.forEach((entry) => {
        const href = path.join(reqPath, entry.name);
        const displayName = entry.isDirectory ? `${entry.name}/` : entry.name;
        const size = entry.isDirectory ? "-" : entry.size;
        const mtime = entry.mtime.toLocaleString();

        html += `
          <tr>
            <td class="${
              entry.isDirectory ? "dir" : ""
            }"><a href="${href}">${displayName}</a></td>
            <td>${size}</td>
            <td>${mtime}</td>
          </tr>
        `;
      });

      html += `
          </table>
        </body>
        </html>
      `;

      return html;
    });
}

// 辅助函数：生成PROPFIND响应
function generatePropfindResponse(fsPath, reqPath, depth = 0) {
  return fs.stat(fsPath).then((stats) => {
    const isDir = stats.isDirectory();
    const etag = generateETag(stats);
    const mtime = stats.mtime.toUTCString();
    const ctime = stats.ctime.toUTCString();
    const size = isDir ? 0 : stats.size;

    let response = `
        <D:multistatus xmlns:D="DAV:">
          <D:response>
            <D:href>${reqPath}</D:href>
            <D:propstat>
              <D:prop>
                <D:creationdate>${ctime}</D:creationdate>
                <D:getlastmodified>${mtime}</D:getlastmodified>
                <D:getetag>${etag}</D:getetag>
                <D:getcontentlength>${size}</D:getcontentlength>
                <D:getcontenttype>${
                  isDir ? "httpd/unix-directory" : "application/octet-stream"
                }</D:getcontenttype>
                <D:resourcetype>${
                  isDir ? "<D:collection/>" : ""
                }</D:resourcetype>
              </D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
      `;

    if (isDir && depth > 0) {
      return fs.readdir(fsPath).then((files) => {
        const entries = files.map((file) => {
          const entryPath = path.join(fsPath, file);
          const entryReqPath =
            path.join(reqPath, file) + (reqPath === "/" ? "" : "/");

          return fs.stat(entryPath).then((entryStats) => {
            const entryIsDir = entryStats.isDirectory();
            const entryEtag = generateETag(entryStats);
            const entryMtime = entryStats.mtime.toUTCString();
            const entryCtime = entryStats.ctime.toUTCString();
            const entrySize = entryIsDir ? 0 : entryStats.size;

            return `
                    <D:response>
                      <D:href>${encodeURI(entryReqPath)}</D:href>
                      <D:propstat>
                        <D:prop>
                          <D:creationdate>${entryCtime}</D:creationdate>
                          <D:getlastmodified>${entryMtime}</D:getlastmodified>
                          <D:getetag>${entryEtag}</D:getetag>
                          <D:getcontentlength>${entrySize}</D:getcontentlength>
                          <D:getcontenttype>${
                            entryIsDir
                              ? "httpd/unix-directory"
                              : "application/octet-stream"
                          }</D:getcontenttype>
                          <D:resourcetype>${
                            entryIsDir ? "<D:collection/>" : ""
                          }</D:resourcetype>
                        </D:prop>
                        <D:status>HTTP/1.1 200 OK</D:status>
                      </D:propstat>
                    </D:response>
                  `;
          });
        });

        return Promise.all(entries).then((entriesXml) => {
          response += entriesXml.join("");
          response += `</D:multistatus>`;
          return response;
        });
      });
    } else {
      response += `</D:multistatus>`;
      return response;
    }
  });
}

// 请求处理函数
async function handleRequest(req, res) {
  console.log(`收到请求: ${req.method} ${req.url}`);
  const fsPath = getFileSystemPath(req.url);
  console.log(`文件系统路径: ${fsPath}`);
  // 安全检查
  if (!isPathInRoot(fsPath)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("禁止访问");
    return;
  }

  try {
    switch (req.method) {
      case "OPTIONS":
        res.writeHead(200, {
          Allow: "OPTIONS, GET, HEAD, POST, PUT, DELETE, MKCOL, PROPFIND",
          DAV: "1,2",
          "MS-Author-Via": "DAV",
        });
        res.end();
        break;

      case "GET":
        try {
          const stats = await fs.stat(fsPath);
          if (stats.isDirectory()) {
            // 返回目录列表
            const html = await generateDirectoryListing(fsPath, req.url);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
          } else {
            // 返回文件内容
            const stream = fsSync.createReadStream(fsPath);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              ETag: generateETag(stats),
              "Last-Modified": stats.mtime.toUTCString(),
            });
            stream.pipe(res);
          }
        } catch (err) {
          if (err.code === "ENOENT") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("文件未找到");
          } else {
            throw err;
          }
        }
        break;

      case "HEAD":
        try {
          const stats = await fs.stat(fsPath);
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": stats.size,
            ETag: generateETag(stats),
            "Last-Modified": stats.mtime.toUTCString(),
          });
          res.end();
        } catch (err) {
          if (err.code === "ENOENT") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("文件未找到");
          } else {
            throw err;
          }
        }
        break;

      case "PUT":
        try {
          const writeStream = fsSync.createWriteStream(fsPath);
          req.pipe(writeStream);

          writeStream.on("finish", () => {
            res.writeHead(201, { "Content-Type": "text/plain" });
            res.end("文件已创建");
          });

          writeStream.on("error", (err) => {
            console.error("写入文件失败:", err);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("服务器错误");
          });
        } catch (err) {
          console.error("PUT请求处理失败:", err);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("服务器错误");
        }
        break;

      case "DELETE":
        try {
          const stats = await fs.stat(fsPath);
          if (stats.isDirectory()) {
            await fs.rmdir(fsPath, { recursive: true });
          } else {
            await fs.unlink(fsPath);
          }
          res.writeHead(204);
          res.end();
        } catch (err) {
          if (err.code === "ENOENT") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("文件/目录未找到");
          } else {
            throw err;
          }
        }
        break;

      case "MKCOL":
        try {
          await fs.mkdir(fsPath);
          res.writeHead(201, { "Content-Type": "text/plain" });
          res.end("目录已创建");
        } catch (err) {
          if (err.code === "EEXIST") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("方法不允许");
          } else if (err.code === "ENOENT") {
            // 父目录不存在
            res.writeHead(409, { "Content-Type": "text/plain" });
            res.end("父目录不存在");
          } else {
            throw err;
          }
        }
        break;

      case "PROPFIND":
        try {
          const depth = req.headers["depth"] || "0";
          const stats = await fs.stat(fsPath);

          if (stats.isDirectory()) {
            const response = await generatePropfindResponse(
              fsPath,
              req.url,
              depth === "infinity" ? 1 : parseInt(depth)
            );
            res.writeHead(207, {
              "Content-Type": 'application/xml; charset="utf-8"',
              DAV: "1,2",
            });
            res.end(response);
          } else {
            const response = await generatePropfindResponse(fsPath, req.url, 0);

            res.writeHead(207, {
              "Content-Type": 'application/xml; charset="utf-8"',
              DAV: "1,2",
            });
            res.end(response);
          }
        } catch (err) {
          if (err.code === "ENOENT") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("资源未找到");
          } else {
            throw err;
          }
        }
        break;

      default:
        res.writeHead(405, {
          "Content-Type": "text/plain",
          Allow: "OPTIONS, GET, HEAD, POST, PUT, DELETE, MKCOL, PROPFIND",
        });
        res.end("方法不允许");
    }
  } catch (err) {
    console.error("服务器错误:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("服务器错误");
  }
}

// 创建HTTP服务器
const httpServer = http.createServer(handleRequest);
httpServer.listen(PORT, () => {
  console.log(`HTTP WebDAV服务器运行在端口 ${PORT}`);
  console.log(`根目录: ${ROOT_DIR}`);
});
