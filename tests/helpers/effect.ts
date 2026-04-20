import { Cause, Effect, Exit } from "effect"

export async function runEffectOrThrow<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === "Some") {
    throw failure.value
  }

  throw new Error(Cause.pretty(exit.cause))
}
