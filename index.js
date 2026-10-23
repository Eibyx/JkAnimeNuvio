require("dotenv").config()
const { start } = require("./lib/server")

const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || "0.0.0.0"

start({ port, host })
