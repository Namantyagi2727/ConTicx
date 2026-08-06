import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">ConTicx</h1>
      <p className="text-gray-600">Phase 1: one end-to-end sandbox payment.</p>
      <Link
        href="/checkout"
        className="rounded-md bg-black px-4 py-2 text-white"
      >
        Go to test checkout
      </Link>
    </main>
  );
}
