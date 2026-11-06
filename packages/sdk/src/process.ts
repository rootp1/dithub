const ISOLATED_GIT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
]

export function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const variable of ISOLATED_GIT_VARIABLES) delete environment[variable]
  return environment
}
