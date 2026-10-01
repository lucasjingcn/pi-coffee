declare module "proper-lockfile" {
  const lockfile: {
    lock(path: string, options: { realpath: boolean; retries: { retries: number; minTimeout: number; maxTimeout: number; randomize: boolean } }): Promise<() => Promise<void>>;
  };
  export default lockfile;
}
