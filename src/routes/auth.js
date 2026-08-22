const express = require("express");
const bcrypt = require("bcryptjs");
const usersRepo = require("../db/usersRepo");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    const user = await usersRepo.getUserByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    return res.json({ username: user.username });
  } catch (err) {
    console.error("Login failed:", err);
    return res.status(500).json({ error: "Something went wrong logging in." });
  }
});

router.post("/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Not logged in." });
  res.json({ username: req.session.username });
});

module.exports = router;
