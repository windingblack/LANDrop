const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('./config.json');
const iconv = require('iconv-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 数据库路径
const dbPath = path.resolve(config.dbPath || './chat.db');
const db = new sqlite3.Database(dbPath);

// 创建 messages 表
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT,
  type TEXT,
  content TEXT,
  filename TEXT,
  mimetype TEXT,
  deleted INTEGER DEFAULT 0
)`);

// 静态文件目录
app.use(express.static('public'));
app.use(express.json());

// 上传文件夹路径
const uploadPath = path.resolve(config.uploadDir || 'uploads');
fs.mkdirSync(uploadPath, { recursive: true });

// multer 存储设置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// 上传接口
app.post('/upload', upload.single('fileData'), (req, res) => {
  const file = req.file;
  if (file) {
    const savedFilename = `${file.filename}`;
    const timestamp = new Date().toISOString();

    // 修正文件名编码问题
    let originalname = file.originalname;

    // 判断是否为乱码（即不是合法的 UTF-8 字符串），转码
    if (!/^[\u0000-\u007F]*$/.test(originalname)) {
      // 如果有非 ASCII 字符，尝试用 latin1 解码成 UTF-8
      originalname = iconv.decode(Buffer.from(file.originalname, 'latin1'), 'utf8');
    }

    db.run(
      'INSERT INTO messages (time, type, content, filename, mimetype) VALUES (?, ?, ?, ?, ?)',
      [timestamp, file.mimetype.startsWith('image') ? 'image' : 'file', savedFilename, originalname, file.mimetype]
    );

    db.get('SELECT * FROM messages WHERE time = ? AND content = ? AND filename = ?', [timestamp, savedFilename, originalname], (err, row) => {
      if (err || !row) {
        return res.json({ success: false, error: 'Failed to load record' });
      }

      io.emit('chat message', row);
    });
    
    res.json({ url:  '/file/' + file.savedFilename });
  } else {
    res.status(400).send('No file uploaded');
  }
});

app.get('/file/:filename', (req, res) => {
  const filename = req.params.filename;

  db.get('SELECT filename, mimetype FROM messages WHERE content = ?', [filename], (err, row) => {
    if (err || !row) {
      return res.status(404).send('File not found');
    }
    const filePath = path.join(uploadPath, filename);
    res.setHeader('Content-Type', row.mimetype);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
    // 返回文件内容，不设置下载标头（即不使用 res.download）
    res.sendFile(filePath, err => {
      if (err) {
        console.error('Send file error:', err);
        if (!res.headersSent) {
          res.status(500).send('File send failed');
        }
      }
    });
  });
});

// app.js 部分
app.get('/messages', (req, res) => {
  const pageSize = config.pageSize || 20;
  let offset = parseInt(req.query.offset) || 0;

  // 先查询总数
  db.get('SELECT COUNT(*) as count FROM messages', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    const total = row.count;

    // 计算从后面往前查：先显示最新的 N 条，offset 是向上加载的偏移
    // SQLite 不支持负 offset，所以用倒序分页，客户端从最新消息开始分页
    db.all(
      `SELECT * FROM messages ORDER BY time DESC LIMIT ? OFFSET ?`,
      [pageSize, offset],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // 因为是倒序，前端要反转一次才是时间升序
        res.json({
          total,
          pageSize,
          offset,
          messages: rows.reverse(),
        });
      }
    );
  });
});

app.post('/delete/:id', (req, res) => {
  const id = req.params.id;

  db.get('SELECT content, filename FROM messages WHERE id = ? AND type = ?', [id, 'file'], (err, row) => {
    if (err || !row) {
      return res.json({ success: false, error: 'File not found' });
    }

    const filePath = path.join(uploadPath, row.content)
    let deleted = true;

    fs.access(filePath, fs.constants.F_OK, (err) => {
      if (!err) {
        fs.unlink(filePath, (fsErr) => {
          if (fsErr) {
            deleted = false;
            return res.json({ success: false, error: 'Failed to delete file' });
          }
        });
      } else {
        console.warn(`File [${row.content}] not found, nothing to delete.`);
      }
    });

    // 标记为删除
    db.run('UPDATE messages SET deleted = 1 WHERE id = ?', [id], (updateErr) => {
      if (updateErr) {
        return res.json({ success: false, error: 'Failed to update record' });
      }
      res.json({ success: true });
    });
  });
});



// socket.io 实时通信
io.on('connection', (socket) => {
  console.log('a user connected');

  socket.on('chat message', (msg) => {
    const timestamp = new Date().toISOString();
    db.run('INSERT INTO messages (time, type, content) VALUES (?, ?, ?)', [timestamp, 'text', msg]);
    io.emit('chat message', { time: timestamp, type: 'text', content: msg });
  });

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

// 启动服务器，监听所有网卡地址，支持局域网访问
server.listen(config.port || 3000, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${config.port || 3000}`);
});
