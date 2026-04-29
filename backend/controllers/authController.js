const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { client } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'secret_para_ia_note_123';

exports.register = async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = Date.now().toString();

        await client.execute({
            sql: "INSERT INTO users (id, username, password) VALUES (?, ?, ?)",
            args: [userId, username, hashedPassword]
        });

        res.json({ message: 'Usuario registrado con éxito' });
    } catch (error) {
        if (error.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'El nombre de usuario ya existe' });
        }
        res.status(500).json({ error: 'Error al registrar usuario' });
    }
};

exports.login = async (req, res) => {
    try {
        const { username, password } = req.body;
        const rs = await client.execute({
            sql: "SELECT * FROM users WHERE username = ?",
            args: [username]
        });

        if (rs.rows.length === 0) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }

        const user = rs.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }

        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, username: user.username });
    } catch (error) {
        res.status(500).json({ error: 'Error al iniciar sesión' });
    }
};

// Middleware para proteger rutas
exports.authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'No autorizado' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Sesión expirada' });
        req.user = user;
        next();
    });
};
