require("dotenv").config()
const { createApp } = require("./lib/app")

const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || "0.0.0.0"

createApp().listen(port, host, () => {
  console.log(`JKAnimeNuvio listening on http://${host}:${port}/manifest.json`)
})
