import { greet } from "./greeter.js"
import { registry } from "./registry.js"

/** Fixture importer that touches two changed files. */
export const greetAll = (): string[] =>
  [...registry.keys()].map((registeredName) => greet(registeredName))
