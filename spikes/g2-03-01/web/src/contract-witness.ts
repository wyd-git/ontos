import type {
  ObjectTypeMetadata,
  PolicyDisposition,
} from "./generated/types.gen.ts";

export function requiredContractWitness(metadata: ObjectTypeMetadata): string {
  const apiName: string = metadata.apiName;
  const displayName: string = metadata.displayName;
  return `${apiName}:${displayName}`;
}

export function exhaustiveDispositionWitness(disposition: PolicyDisposition): string {
  switch (disposition) {
    case "allow":
      return "visible";
    case "mask":
      return "masked";
    case "restricted":
      return "restricted";
    default: {
      const unreachable: never = disposition;
      return unreachable;
    }
  }
}
