export class IrdaError extends Error {}

export class ConnectionClosed extends IrdaError {
  constructor(message = "Connection closed") {
    super(message)
  }
}
