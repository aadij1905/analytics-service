const express = require("express");
const path = require("path");
const cors = require("cors");
const analyticsRouter = require("./routes/analytics");
const ingestRouter = require("./routes/ingest");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use("/screenshots", express.static(path.join(__dirname, "screenshots")));

app.use("/", analyticsRouter);
app.use("/", ingestRouter);

app.listen(PORT, () => {
  console.log(`Analytics service running on port ${PORT}`);
});

module.exports = app;
