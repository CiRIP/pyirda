export async function ok<T extends USBInTransferResult | USBOutTransferResult>(transfer: Promise<T>): Promise<T> {
  const result = await transfer
  if (result.status !== "ok") throw new Error(`USB transfer failed: ${result.status}`)

  return result
}

export async function claim(device: USBDevice): Promise<USBInterface> {
  await device.open()
  if (!device.configuration) await device.selectConfiguration(1)

  const [usbInterface] = device.configuration!.interfaces
  await device.claimInterface(usbInterface.interfaceNumber)

  return usbInterface
}

export const bulk = ({ alternate }: USBInterface, direction: USBDirection) =>
  alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === direction)!
