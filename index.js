const express = require("express");
const app = express();

app.use(express.json());

// Test
app.get("/", (req, res) => {
  res.send("Backend BekaWiFi OK");
});

// Callback Ligdicash
app.post("/callback-ligdicash", (req, res) => {
  console.log("Callback reçu :", req.body);

  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
