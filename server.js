const fs = require("fs");
const path = require("path");
const express = require("express");

/**
 * Lightweight .env loader so we don't rely on external packages.
 * Only parses simple KEY=VALUE pairs and ignores comments.
 */
function loadEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const idx = trimmed.indexOf("=");
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      if (!key) return;
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch (err) {
    // Silently ignore missing or unreadable .env files.
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const app = express();

// Serve static assets from /public
app.use(express.static(path.join(__dirname, "public")));

// Dedicated route for the teacher console
app.get("/console", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "console.html"));
});

// Expose Supabase configuration to the browser safely
app.get("/env.js", (_req, res) => {
  const config = {
    projectUrl: process.env.PROJECT_URL || "",
    anonKey: process.env.ANON_KEY || "",
  };

  res.type("application/javascript");
  res.send(`window.__SUPABASE_CONFIG__ = ${JSON.stringify(config)};`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
