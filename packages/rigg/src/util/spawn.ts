type Resolve = (
  command: string,
  options: {
    PATH?: string
    cwd: string
  },
) => string | null

export type SpawnSpec = {
  cmd: string[]
  windowsVerbatimArguments?: true
}

export function spawnSpec(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string>
    platform?: NodeJS.Platform
    resolve?: Resolve
  },
): SpawnSpec {
  const platform = options.platform ?? process.platform
  if (platform === "win32") {
    return windowsSpawnSpec(command, args, options)
  }

  return {
    cmd: [resolveCmd(command, options), ...args],
  }
}

function windowsSpawnSpec(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string>
    resolve?: Resolve
  },
): SpawnSpec {
  const resolved = resolveCmd(command, options)
  const doubleEscape = isBatchFile(resolved)
  const shell = options.env["COMSPEC"] ?? process.env["COMSPEC"] ?? "cmd.exe"
  const script = [resolved, ...args].map((part) => quoteWindowsArg(part, doubleEscape)).join(" ")

  return {
    cmd: [shell, "/d", "/s", "/c", `"${script}"`],
    windowsVerbatimArguments: true,
  }
}

function resolveCmd(
  command: string,
  options: {
    cwd: string
    env: Record<string, string>
    resolve?: Resolve
  },
): string {
  const resolve = options.resolve ?? defaultResolve
  const path = options.env["PATH"]
  return resolve(command, path === undefined ? { cwd: options.cwd } : { PATH: path, cwd: options.cwd }) ?? command
}

function defaultResolve(
  command: string,
  options: {
    PATH?: string
    cwd: string
  },
): string | null {
  return Bun.which(command, options)
}

function quoteWindowsArg(argument: string, doubleEscape: boolean): string {
  let escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")

  escaped = `"${escaped}"`
  escaped = escaped.replace(/[()%!^"<>&|]/g, "^$&")

  if (doubleEscape) {
    escaped = escaped.replace(/[()%!^"<>&|]/g, "^$&")
  }

  return escaped
}

function isBatchFile(command: string): boolean {
  return /\.(?:bat|cmd)$/i.test(command)
}
