import { greet } from "./greeter.js"

export const shout = (name: string): string => greet(name).toUpperCase()
