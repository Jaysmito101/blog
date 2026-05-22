---
title: "Building a Fast Lock-Free Queue in Modern C++ From Scratch"
pubDate: "2026-05-22 10:00:00"
description: "Why do standard mutex-based queues feel very slow under extreme contention? Lets take a deep dive into the chaotic world of lock-free programming, Hazard Pointers, cache-line optimizations, and C++20 concepts to build a Multi-Producer Multi-Consumer queue that scales to dozens of threads without choking on the OS scheduler."
tags: ["C++", "optimization", "advanced", "data structures", "lock-free programming", "concurrency"]
cover: ""
---

For those just interested in the code you can find it [here](https://gist.github.com/Jaysmito101/11a85e67732b9a9177b4270c60195ae9) and if you want to see it action in an actual project you can check [this](https://github.com/Jaysmito101/Xlux/blob/main/XluxEngine/Include/Core/Queue.hpp) out!

Now to set the context for those who might be new to this, typically a Queue is one of the most fundamental data structures in computer science, and it is used everywhere in software development. A queue is a simple first-in-first-out (FIFO) structure where you can `Push` items to the back and `Pop` items from the front. In single-threaded code, there are already implementations in most standard libraries, for instance in C++ its `std::queue`, and even implement it from sratch is pretty trivial. 

So why all the trouble you ask?

Its simply because when we move over to a multi threaded environemnt(a typical requirement for a whole lot of real world applications), the whole thing becomes a whole lot more complex, now you have multiple threads `contending` or fighting for the data in your queue, and if you dont manage it properly you get the classical Undefined Behaviour, that is one theads makes some chnages while another tires to read causing all sort of corruptions. 

Now before you proceed, its very important to ask yourself, 

Do you reallly need a fast lock-free queue? 

Then answer is for most applications you typically dont. You are all good with typicall mutex based synchronizatons you can add on a regular queue.

However, once you start dealing with more demanding things like high frequency trading systems, real time game engines, audio synthesis pipelines, massive data ingestion systems, or any situtuation where you got a large number of threads trying to communicate, the performance of the queue suddenly starts mattering a lot. In these systems even a fraction of a millisecond of delay in one queue operation cascades into stuttering audio, dropped frames, missed trades, or just an overall sluggish system. So we really do want our queue to be fast, ideally something that scales linearly with the number of threads instead of falling apart the moment you have more than a couple of producers and consumers.

For me personally, I was working on optimizing my [software renderer](https://github.com/Jaysmito101/Xlux) by re-architecturing thing a bit, and this seemed to be one of the bigged contenders with all the multithreaded CPU work going on.

## The Idea? (Motivation & Baselines)

Alright, almost every C++ tutorial about threading tells you to just slap a `std::mutex` on top of a `std::queue` and call it a day. And honestly for 90% of all cases that is exactly the right call, mutexes are well tested, easy to reason about, and the standard library implementation is genuinely fast for low contention scenarios. So lets not throw that away, lets start there. We will write the simplest possible thread safe queue, call it `SimpleQueue`, and use it as our baseline to compare everything against.

The implementation is essentially what you would write as a starting point for any multi-threaded application. We wrap a `std::queue<T>` with a `std::mutex`, and every `Push` and `Pop` operation just acquires the mutex, does the queue operation, and releases the mutex. We also make it non copyable and non movable because, well, copying a mutex doesnt make any sense. And we add a `threadId` parameter to all the methods even though we dont use it, because all our queues later will need it, and keeping the API identical makes benchmarking and comparing the queues easier.

```cpp
template <typename T>
class SimpleQueue {
 public:
  SimpleQueue() = default;
  SimpleQueue(SimpleQueue<T>&) = delete;
  SimpleQueue(SimpleQueue<T>&&) = delete;

  void Push(T* item, uint32_t threadId) {
    (void)threadId;
    std::unique_lock lock(m_Mutex);
    m_Queue.push(*item);
  }

  bool Pop(T* item, uint32_t threadId) {
    (void)threadId;
    std::unique_lock lock(m_Mutex);
    if (m_Queue.empty()) {
      return false;
    }
    *item = std::move(m_Queue.front());
    m_Queue.pop();
    return true;
  }

  // This is an extremely handy function which we can add to the 
  // Queue API so that we can use it to check if a queue is filled
  // or not and this will be very useful for a lot of situations
  // where you could technically put a thread to sleep based on
  // this value.
  bool IsEmpty(uint32_t threadId) {
    (void)threadId;
    std::unique_lock lock(m_Mutex);
    return m_Queue.empty();
  }

 private:
  std::queue<T> m_Queue;
  mutable std::mutex m_Mutex;
};
```

Looks incredibly clean right? It works, its correct, and for 2 or 3 threads gently feeding each other data, its honestly pretty fast. But ask yourself, what *actually* happens when you have 16 threads all hammering this queue thousands of times per second? What does the mutex really do under the hood when a thread tries to lock something that is already locked by another thread? The thread cant just spin forever wasting CPU, so what does it do?

The OS scheduler steps in, and it does something really expensive called a **context switch**. When a thread fails to grab a lock, the kernel marks it as blocked, saves its entire CPU register state, flushes parts of the TLB, evicts it from its CPU core, picks a different runnable thread, restores *its* register state, and finally hands the core to the new thread. Then when the original mutex holder releases the lock, the kernel has to do all of this in reverse to wake the waiting thread back up. Each context switch costs something on the order of a few microseconds, which doesnt sound like much until you realize the actual queue operation itself takes only a few *nanoseconds*. So you are spending three orders of magnitude more time switching threads than actually doing useful work. Under heavy contention your program ends up spending the vast majority of its CPU budget inside the kernel just shuffling threads around, and the standard library queue you put so much trust in starts looking like a parking lot at rush hour.

Fun Face: *Modern mutexes are technically "hybrid" they spin a few times in user space before falling back to a kernel wait, so the cost isnt always this bad. But under sustained contention with many threads, you absolutely will hit the kernel path, and the pattern above describes what happens. Also other than mutex there are another set of synchronization structure called a futex, a futex is a 'fast userspace mutex', whose goal is to try to keep things in the userspace to reduce the overhead of the kernel stepping in, we will use something like that later in our implemnetation for some extra features, but still thats not really as performant as we want it to be for a critical path queue*

So the goal is clear, can we build something that *never* puts a thread to sleep actively? Something where threads communicate purely through atomic operations on shared memory, and even when they "fail" to make progress they just retry in a tight loop instead of paying for a context switch? That is what we mean by **lock free**, and that is what the rest of this post is going to obsess over.

NOTE: Something you should always keep in mind is, that all we can do is try to not force the kernel to do a context switch actively, howver since most modern operating systems use preemptive scheduling, its impossible to prevent 100% of all contex switched, however we can write the code in a way that a context switch naturally occuring wont cost use extra.

## What is Lock-Free Anyway? 

Now when people first hear "lock free", a lot of them assume it just means "I sprinkled `std::atomic` in my code somewhere". Which is technically a starting point, but its missing the actual core idea. Lock free programming is really about replacing pessimistic blocking with optimistic retrying. Instead of saying "I will wait until I have exclusive access", you say "I will read the current state, compute what I want to change it to, and then atomically swap it only if nobody else changed it in the meantime, otherwise I will try again". The key primitive that makes this possible is **Compare And Swap**, almost always abbreviated to **CAS**.

CAS is a single hardware instruction on basically every modern CPU. In C++ we get it through `std::atomic::compare_exchange_strong` (or its weak variant). The signature looks like this:

```cpp
std::atomic<int> value{42};

int expected = 42;
int desired  = 100;
if (value.compare_exchange_strong(expected, desired)) {
  // success! value was 42, now it is 100
} else {
  // failure, `expected` now holds the actual current value
}
```

So the CAS atomically checks "is `value` currently equal to `expected`? If yes, set it to `desired` and return true. If no, write the actual current value into `expected` and return false." Notice that the failure case is incredibly useful, it tells you what the value actually was, so you can recompute your desired change and loop back to try again. This loop is so common it has a name, the **CAS loop**, and once you start writing lock free code you will see it absolutely everywhere.

NOTE: *Throughout our implementation we strictly use `compare_exchange_strong`, but the C++ standard suggests that for some systems like ARM it mighe be a better idea to run a loop with `compare_exchange_weak` for better performance. The problem with that is a `compare_exchange_weak` call may fail spuriously, which essentially it can randomly fail even if everything is correct, thus it makes code code a bit more complicated, so I avoided it for this implementation.*

Now lets think about how we might use CAS to build a lock free queue. Now, the base of our queue would be a linked list. The reason being it is much easier to grow compared to buffers, as we dont need to think about reallocation and moving of the data when growing, and its crucial for cases where we could have millions of additions and removals in very short periods of times, the like of which we typically see in environements we want a lock-free queue for. The naive sketch is something like, push a node by doing a CAS on the head pointer to swing it to the new node, and pop a node by doing a CAS on the tail pointer to move it past the consumed node. We delete the node after we pop it. Simple, elegant, and on first read it looks like it should just work.

So lets just swap pointers and we are lock free, right?

Spoiler: **No.**

And the reason it doesnt work is one of the most infamous traps in all of concurrent programming, the **ABA problem**.

Suppose Thread A is about to pop. It reads the tail pointer and sees it pointing to some node `X`. Thread A is then preempted by the OS right before it executes its CAS. Now Thread B comes in, pops node `X` (legally, the CAS succeeds because nothing has changed yet), and proceeds to call `delete X`. Then Thread B does a few more pushes and pops, and at some point a future `new Node()` happens to return *the same memory address* as the old `X`, because the allocator is allowed to reuse freed memory and almost always will. Now Thread B pushes this brand new node back into the queue, and the tail again points to address `X`, but it is no longer the same logical node, just the same address with completely different contents.

Thread A finally wakes up. It runs its CAS, "is the tail still equal to `X`?" Yes! The address matches! The CAS succeeds! Thread A then proceeds to dereference what it thinks is the old `X` to extract its `next` pointer, but the contents have been completely rewritten by Thread B, so Thread A reads a totally garbage `next`, follows it into hyperspace, and your program either crashes immediately with a segfault or, much worse, silently corrupts the queue and crashes ten minutes later in a place that has nothing to do with the actual bug. This is the ABA problem, the value goes from A to B and back to A, and any code that only checks the pointer value cant tell the difference.

NOTE: *The ABA problem is exactly why naive lock free programming is so dangerous. You are fighting against the CPU, the OS scheduler, AND the memory allocator all at the same time. Solving it requires either tagged pointers (which limit you to 48 bits of actual address on most platforms), epoch based reclamation, or hazard pointers. We are going with hazard pointers later, because they are the most general and the most fun to implement.*

There is also a whole rabbit hole here about **memory orderings**. CAS isnt just "atomic", it also tells the compiler and the CPU what kinds of reorderings of surrounding loads and stores are allowed. The default `std::memory_order::seq_cst` is the safest and slowest, while `acquire`, `release`, and `relaxed` give you finer grained control at the cost of having to actually think about what other threads can observe. We will use all four orderings in the final implementation, but for now just keep in mind that lock free programming is not just "use atomics", it is "use atomics with the correct memory ordering, and have a story for memory reclamation". 

If you are interested in learning a bit more about these memory ordering please take a look at: https://en.cppreference.com/cpp/atomic/memory_order
This is going to be super useful later on for performance.

## Part I: The Basic Lock-Free Queue 

Alright, before we go off and design the perfect queue, lets first build the simple lock free queue and watch it explode in our face. This is genuinely useful, both for understanding why all the future complexity is necessary, and because it will give us a second baseline to benchmark against. We will call this one `NaiveLockFreeQueue`.

The node structure is what you would expect, a payload and an atomic next pointer.

```cpp
template <typename T>
struct NaiveNode {
  T data;
  std::atomic<NaiveNode*> next;
};
```

And here is a sketch of the queue itself with `Push` and `Pop`. Notice how I am using CAS loops to swing the head and tail pointers around. This follows the classic [Michael Scott queue](https://www.cs.rochester.edu/u/scott/papers/1996_PODC_queues.pdf) design, which is the textbook lock free MPMC queue.

```cpp
template <typename T>
class NaiveLockFreeQueue {
 public:
  NaiveLockFreeQueue() {
    auto dummy = new NaiveNode<T>();
    dummy->next.store(nullptr);
    head.store(dummy);
    tail.store(dummy);
  }

  // NOTE: ideally you would have a destructor to actually
  // clean up all the items still in the queue to prevent
  // a memory leak, but for simplicity I have skipped it here

  void Push(T* value, uint32_t /*threadId*/) {
    auto newNode = new NaiveNode<T>();
    newNode->data = *value;
    newNode->next.store(nullptr, std::memory_order::relaxed);

    while (true) {
      auto currentHead = head.load(std::memory_order::acquire);
      auto currentNext = currentHead->next.load(std::memory_order::acquire);

      if (currentHead != head.load(std::memory_order::acquire)) continue;

      if (currentNext == nullptr) {
        NaiveNode<T>* expected = nullptr;
        if (currentHead->next.compare_exchange_strong(expected, newNode)) {
          head.compare_exchange_strong(currentHead, newNode);
          return;
        }
      } else {
        head.compare_exchange_strong(currentHead, currentNext);
      }
    }
  }

  bool Pop(T* value, uint32_t /*threadId*/) {
    while (true) {
      auto currentTail = tail.load(std::memory_order::acquire);
      auto currentHead = head.load(std::memory_order::acquire);
      auto next        = currentTail->next.load(std::memory_order::acquire);

      if (currentTail != tail.load(std::memory_order::acquire)) continue;

      if (currentTail == currentHead) {
        if (next == nullptr) return false;
        head.compare_exchange_strong(currentHead, next);
      } else {
        if (!next) continue;
        *value = next->data;
        if (tail.compare_exchange_strong(currentTail, next)) {
          delete currentTail;
          return true;
        }
      }
    }
  }

 private:
  std::atomic<NaiveNode<T>*> head;
  std::atomic<NaiveNode<T>*> tail;
};
```

Take a moment to actually read through that. The structure is fine, the pointer arithmetic is fine, and if you run it single threaded it works perfectly. If you run it with 2 producers and 2 consumers under light load it also probably works, because the threads rarely overlap. But the moment you crank the contention up, this thing starts behaving in absolutely terrible ways, and the reasons are quite imterestomg.

The first terrible drawback is the **severe memory allocation overhead**. Every single `Push` calls `new NaiveNode<T>()`, and every single successful `Pop` calls `delete currentTail`. So if you are pushing five million items, you are doing five million heap allocations and five million heap frees. The default heap allocator on most operating systems is *itself* protected by internal locks, because the heap is a shared resource that needs to maintain its own invariants. So in our quest to avoid locks, we accidentally moved the lock from our queue into the C runtime. The kernel might not see the contention anymore, but the heap absolutely does, and the threads that were supposed to be running independently are now serializing on the malloc lock instead. The end result is that the "lock free" queue is sometimes *slower* than the mutex based one, which is exactly what our benchmarks at the end will show.

Now, before you jump at me saying "we could just use a better allocator, for this, with optimizations like thread local caching", yes you could but that it doenst mean we should implement out base queue in a worse way and hope a better allocator will fix that.

The second drawback is **terrible cache locality**. Modern CPUs are built around the assumption that memory you access is close to memory you accessed recently, both in time and in space. When a CPU touches an address, it pulls in the surrounding 64 bytes (a "cache line") and keeps it in the L1 cache. If your next access is on that same cache line, it is essentially free, maybe one or two CPU cycles. If your next access is in main memory, it can cost two or three *hundred* cycles, and during that time the CPU just sits there waiting. Our naive linked list nodes are scattered all over the heap, one node here, the next node maybe 400KB away, the one after that maybe on a totally different page. Every traversal becomes a parade of cache misses, and the CPU spends most of its time stalled on memory rather than doing actual work.

The third drawback, and the one that will actively crash your program, is the **use-after-free / ABA combo**. Remember the scenario from the previous section, Thread A reads `tail`, gets preempted, Thread B pops the node and calls `delete` on it, the allocator reuses the address for a brand new node, Thread A wakes up and dereferences what it thinks is the old node. With the naive implementation, this exact sequence can happen at any time under load, and when it does you get a segfault, or memory corruption, or a phantom read of stale data. 

## Part II: Batching to the Rescue

Okay so the naive queue had three big problems, too many allocations, awful cache behavior, and unsafe memory reclamation. We will deal with the memory reclamation problem in the next section using hazard pointers, but right now we can attack the first two problems with one really effective change, **dont store one element per node, store an entire array of elements per node**. Each node becomes a fixed size block of slots, and we only allocate a new node when the current block fills up. If our block size is say 1024, we just turned 1024 allocations into 1, and the throughput jumps accordingly.

The basic idea is that producers will push into the slots of the current "head" block, atomically incrementing a slot index. Consumers will pop from the slots of the current "tail" block, atomically incrementing their own slot index. When a producer finds the head block is full, it allocates a new node and links it as the next block. When a consumer drains the tail block, it advances tail to the next block and retires the empty one. The pointer level work happens once per block instead of once per element, which is exactly the optimization we wanted.

The smallest building block here is the **slot**, the per element storage location. Each slot holds one value of type `T` plus a one bit flag that says "the producer has finished writing this slot". The flag is essential because the act of "claim slot index" (an atomic fetch_add) is not the same as "data is visible in slot", there is a brief window where the slot is reserved but not yet written. Consumers must wait until the slot is committed before reading. We use `std::atomic_flag` for this because it is the lightest possible atomic primitive in the standard, and it has the bonus that C++20 added `wait()` and `notify_one()` methods on it, which we can use later for blocking consumers without ever touching a mutex. This works with a futex internally on some implementations.

NOTE: *You will see a `FORCE_INLINE` annotation on basically every method from here on. The C++ `inline` keyword is just a hint, modern compilers will often refuse to inline a function if they judge it too large or notice a function pointer taken to it. In hot path code that judgement can be very wrong, the few extra instructions of inlined code save us a full function call, a register spill, and potentially a cache miss on the called function. So we define a cross platform `FORCE_INLINE` macro that uses the right attribute per compiler to override the heuristic and force inlining:*

```cpp
#ifdef _MSC_VER
#define FORCE_INLINE __forceinline
#else
#define FORCE_INLINE __attribute__((always_inline)) inline
#endif
```

*The result is that `Push` or `Pop` typically compiles down to a single inlined sequence with no function call overhead at all, just a few atomic instructions and a memcpy. You can verify this in [Compiler Explorer](https://godbolt.org/) if you want to see the actual assembly.*

```cpp
template <typename T, bool BlockingRead>
  requires std::is_trivially_copyable_v<T>
class FastQueueNodeSlot {
 public:
  FORCE_INLINE FastQueueNodeSlot() {
    commited.clear(std::memory_order::relaxed);
  }

  FORCE_INLINE void Commit(T* value) {
    memcpy(&data, value, sizeof(T));
    commited.test_and_set(std::memory_order::release);
    if constexpr (BlockingRead) {
      commited.notify_one();
    }
  }

  FORCE_INLINE bool IsCommited() const {
    return commited.test(std::memory_order::acquire);
  }

  FORCE_INLINE void WaitTillCommited() const {
    while (!IsCommited()) {
      commited.wait(false, std::memory_order::relaxed);
    }
  }

  FORCE_INLINE bool TryRead(T* value) const {
    if (IsCommited()) {
      memcpy(value, &data, sizeof(T));
      return true;
    }
    return false;
  }

  FORCE_INLINE void Read(T* value) const {
    WaitTillCommited();
    memcpy(value, &data, sizeof(T));
  }

  FORCE_INLINE void Reset() { commited.clear(std::memory_order::relaxed); }

 private:
  T data;
  std::atomic_flag commited;
};
```

A few things to notice here. First, the `requires std::is_trivially_copyable_v<T>` constraint at the top, this is a C++20 concept that legally lets us use `memcpy` instead of an actual copy assignment. This is a hard restriction on what types you can put in the queue, you cant store a `std::string` or a `std::unique_ptr` directly, you have to store either trivial types (ints, pointers, POD structs) or wrap your complex type in a pointer. In return, we bypass the C++ object model entirely, there are no copy constructors to run, no destructors to invoke, no risk of exceptions during a copy leaving the slot in a half written state. The compiler can also vectorize `memcpy` into SIMD register moves when the type is small enough, which can be significantly faster than a hand written copy assignment loop. For a high performance queue this tradeoff is almost always worth it, the consumers of these queues are passing pointers or small POD payloads anyway.

Second, the `Commit` function uses `release` ordering on the flag while `IsCommited` uses `acquire` ordering, this pair gives us the standard release-acquire synchronization, meaning all writes done by the committing thread before the flag is set are guaranteed to be visible to any thread that reads the flag and sees it as set. Third, the `if constexpr (BlockingRead)` branch is going to completely vanish at compile time if `BlockingRead` is false, so the non blocking version pays zero cost for a feature it doesnt use. This is because we dont want to have the overhead of calling `notify_one` if we arent even concernted with waiting for the commited flag anyways, this will become more clear when we start using this slot in the Node implementation.

NOTE: *The blocking path here using `commited.wait()` and `commited.notify_one()` is important. These C++20 primitives are implemented directly on top of the OS futex (on Linux), `WaitOnAddress` (on Windows), or `__ulock_wait` (on macOS). Crucially, these are direct atomic to kernel waits, with no mutex involved, no condition variable, no allocation. A waiting thread parks itself in the kernel directly on the atomic variable, and a notifying thread wakes it directly. This is significantly cheaper than the traditional `std::mutex + std::condition_variable` pattern, and it gives us blocking semantics without dragging mutex contention back into the queue. The `while` loop around `wait` is the standard "spurious wakeup" protection, atomic waits can occasionally return without an actual notify, so you always re-check the predicate before trusting it.*

Now we wrap an array of these slots into a node, plus a head and tail index for the producers and consumers to play with, plus a next pointer for chaining nodes together. The `head` index is incremented atomically by producers to reserve a slot to write into, and the `tail` index is incremented atomically by consumers to reserve a slot to read from. When `tail >= head`, the block has nothing left to consume. When `head == Size`, the block is full and producers need to allocate a new node.

```cpp
template <typename T, uint32_t Size, bool BlockingRead>
class FastQueueNode {
 public:
  using Self = FastQueueNode<T, Size, BlockingRead>;

  FORCE_INLINE FastQueueNode() { Reset(); }

  FORCE_INLINE bool IsUsedUp(std::memory_order memoryOrder) {
    return (tail.load(memoryOrder) >= Size);
  }

  FORCE_INLINE bool Push(T* value) {
    auto oldHead = head.load(std::memory_order::acquire);
    while (true) {
      if (oldHead == Size) {
        return false;
      }
      auto newHead = oldHead + 1;
      if (head.compare_exchange_strong(oldHead, newHead,
                                       std::memory_order::seq_cst,
                                       std::memory_order::acquire)) {
        slots[oldHead].Commit(value);
        return true;
      }
    }
  }

  FORCE_INLINE bool Pop(T* value) {
    auto currentTail = tail.load(std::memory_order::seq_cst);
    while (true) {
      auto currentHead = head.load(std::memory_order::acquire);
      if (currentTail >= currentHead) {
        return false;
      }
      if constexpr (!BlockingRead) {
        if (!slots[currentTail].IsCommited()) {
          return false;
        }
      }
      auto newTail = currentTail + 1;
      if (tail.compare_exchange_strong(currentTail, newTail,
                                       std::memory_order::seq_cst,
                                       std::memory_order::acquire)) {
        slots[currentTail].Read(value);
        return true;
      }
    }
    return false;
  }

  FORCE_INLINE void Reset() {
    head.store(0, std::memory_order::release);
    tail.store(0, std::memory_order::release);
    next.store(nullptr, std::memory_order::release);
    for (auto& slot : slots) {
      slot.Reset();
    }
  }

  FORCE_INLINE Self* Next(std::memory_order memoryOrder) {
    return next.load(memoryOrder);
  }

  FORCE_INLINE bool TrySetNext(Self*& expected, Self* value) {
    return next.compare_exchange_strong(expected, value,
                                        std::memory_order::seq_cst,
                                        std::memory_order::acquire);
  }

  FORCE_INLINE bool IsEmpty(std::memory_order memoryOrder) {
    return tail.load(memoryOrder) >= head.load(memoryOrder);
  }

 private:
  alignas(64) std::array<FastQueueNodeSlot<T, BlockingRead>, Size> slots;
  alignas(64) std::atomic<uint32_t> head;
  alignas(64) std::atomic<uint32_t> tail;
  alignas(64) std::atomic<Self*> next;
};
```

The cache locality story is now dramatically better. All `Size` slots of a node live in one contiguous chunk of memory, so producers writing to consecutive slots prefetch beautifully, and consumers reading consecutive slots prefetch beautifully too. The expensive pointer chasing across nodes happens once every `Size` operations instead of every single operation, and on a typical block size of 1024 that is a roughly 1024x reduction in pointer hops.

Notice also the `alignas(64)` on every field, that is there to prevent **false sharing**. CPU caches operate in cache lines, which on modern x86 and ARM are 64 bytes wide. When a core writes to a cache line, the cache coherence protocol invalidates that cache line in every *other* core, so the next read on those cores has to fetch from a slower level of cache or main memory. This is fine when threads are working on logically related data, but it is a disaster when two completely unrelated atomic variables happen to land on the same cache line. In that case, threads modifying different variables still trigger cross-core invalidations as if they were modifying the same one, and the performance penalty can easily be an order of magnitude. So we force every hot atomic onto its own 64 byte line with `alignas(64)`, even though it wastes some bytes, because the wasted bytes are nothing compared to the cost of a single false-sharing-induced cache miss.

NOTE: *Later in the queue we will also want to align a per-thread `std::vector<Node*>`, but vectors themselves dont let you stick `alignas` on them directly. So we build a tiny generic `Aligned<T, N>` wrapper that forces a given alignment on any wrapped type, with conversion operators:*

```cpp
template <typename T, uint32_t Alignment>
struct alignas(Alignment) Aligned {
 public:
  template <typename... Args>
  FORCE_INLINE constexpr Aligned(Args&&... args)
      : data(std::forward<Args>(args)...) {}

  FORCE_INLINE operator T&() noexcept { return data; }
  FORCE_INLINE operator const T&() const noexcept { return data; }
  T* operator->() noexcept { return &data; }
  const T* operator->() const noexcept { return &data; }
 private:
  T data;
};
```

*This is one of those tiny utilities that you write once and use everywhere. The variadic constructor forwards arguments to the wrapped type, and the conversion operators plus `operator->` mean callers dont even need to know they are holding an `Aligned` rather than the raw type.*

But, and this is a big but, we are still using raw `new` and `delete` for the nodes themselves. So when a block fills up the producer calls `new Node()`, and when a block is drained the consumer wants to call `delete oldTail`. We have made the allocation rate dramatically lower, by a factor of `Size`, but we have not solved the underlying memory reclamation problem. A consumer that calls `delete` on a tail node while another consumer is still in the middle of reading from it will still crash. The ABA problem still applies to the pointer chase between nodes. So before we can call this thing finished, we need a real safe memory reclamation scheme. Enter hazard pointers.

## Part III: Safe Memory Reclamation via Hazard Pointers

Alright, this is the part that I personally find the most fun, because the trick that makes lock free structures actually safe is *so* clever once you see it. The technique is called **hazard pointers**, originally [published by Maged Michael](https://www.cs.otago.ac.nz/cosc440/readings/hazard-pointers.pdf), and the central idea is disarmingly simple. The rule is, "before I dereference a pointer, I publish the pointer to a globally readable location and then double check it still points where I expected. If it does, I have promised the world that I am about to look at this address, and any thread that wants to delete it must check my promise first and defer the delete if my promise is still standing."

So instead of calling `delete node` directly, we call `hp.Retire(node)`, which puts the pointer onto a thread local retired list. Periodically, when the retired list gets long enough, the thread runs a `Scan` pass which collects all the hazard pointers currently published by all threads, sorts them, and only actually deletes the retired pointers that no thread has promised to look at. Pointers that are still "hazarded" by some other thread stay on the retired list and get rechecked the next time around. This is the entire trick, and it cleanly solves both the use-after-free crash and the ABA problem in one go, because while a thread holds a hazard pointer on a node, that node cannot be deleted, so its address cannot be recycled into a brand new node, so the ABA scenario simply cannot occur.

NOTE: *In practice you can also move this periodic `Scan` call in a background thread, essentially making this a garbage collector like system.*

Lets actually build this. We need a thread local state struct that holds the array of hazard pointers this thread is currently publishing, a retired list of pointers this thread wants to delete, and a scratch buffer we will reuse during scans. Putting each thread on its own cache line is essential, otherwise two threads publishing hazard pointers would constantly invalidate each others cache lines and the whole thing would crawl.

```cpp
template <typename T, uint32_t PointerCount>
struct alignas(64) HazardThreadState {
  std::array<std::atomic<T*>, PointerCount> hazardPointers;
  std::vector<T*> retiredPointers;
  std::vector<T*> scratchBuffer;
};
```

Now the main `HazardPointer` class. It owns one `HazardThreadState` per thread, and exposes three core operations, `Protect` to publish a hazard pointer on an atomic, `Release` to clear a hazard pointer slot, and `Retire` to add a node to the deletion queue. The constructor pre-reserves the vectors so we never have to allocate during the hot path, and the destructor asserts that no hazard pointers are still active (which would mean somebody forgot to Release) and cleans up any pointers still sitting on the retired lists.

```cpp
template <typename T, uint32_t ThreadCount, uint32_t PointerCount,
          uint32_t RetireThreshold = 2 * ThreadCount * PointerCount>
  requires(ThreadCount > 0)
class HazardPointer {
 public:
  HazardPointer() {
    for (auto& threadState : state) {
      for (auto& pointer : threadState.hazardPointers) {
        pointer.store(nullptr, std::memory_order::relaxed);
      }
      threadState.retiredPointers.reserve(ThreadCount * PointerCount);
      threadState.retiredPointers.clear();
      threadState.scratchBuffer.reserve(ThreadCount * PointerCount * 4);
      threadState.scratchBuffer.clear();
    }
  }

  ~HazardPointer() {
    for (const auto& threadState : state) {
      assert(std::count_if(
                 threadState.hazardPointers.begin(),
                 threadState.hazardPointers.end(), [](const auto& item) {
                   return item.load(std::memory_order::relaxed) != nullptr;
                 }) == 0);
      for (const auto& ptr : threadState.retiredPointers) {
        if (ptr) delete ptr;
      }
    }
  }

  T* Protect(const std::atomic<T*>& ptr, uint32_t threadId, uint32_t slotId) {
    assert(threadId < ThreadCount);
    assert(slotId  < PointerCount);

    T* p = nullptr;
    do {
      p = ptr.load(std::memory_order::acquire);
      state[threadId].hazardPointers[slotId].store(p, std::memory_order::seq_cst);
    } while (p && p != ptr.load(std::memory_order::seq_cst));
    return p;
  }

  void Release(uint32_t threadId, uint32_t slotId) {
    state[threadId].hazardPointers[slotId].store(nullptr,
                                                 std::memory_order::release);
  }

  void Clear(uint32_t threadId) {
    for (uint32_t slotId = 0; slotId < PointerCount; ++slotId) {
      Release(threadId, slotId);
    }
  }

  template <typename Deleter = std::nullptr_t>
    requires(std::invocable<Deleter, T*> ||
             std::same_as<Deleter, std::nullptr_t>)
  void Retire(T* ptr, uint32_t threadId, Deleter deleter = nullptr) {
    state[threadId].retiredPointers.push_back(ptr);
    if (state[threadId].retiredPointers.size() >= RetireThreshold) {
      Scan(threadId, deleter);
    }
  }

 private:
  std::array<HazardThreadState<T, PointerCount>, ThreadCount> state;
};
```

The `Protect` function is where the actual magic lives. Pay close attention to that loop. We read the atomic, publish what we read into our hazard pointer slot, and then *read the atomic again* and check if it still has the same value. Why? Because between the first load and the publish, another thread could have swung the atomic to a different node and retired the old one. By double checking, we guarantee that if `Protect` returns successfully, the returned pointer is one that was visible to us *after* we published our hazard claim, which means any retiring thread that runs `Scan` after our store will see our hazard pointer and refuse to delete it. The `seq_cst` ordering on the store is intentional, sequentially consistent ordering establishes a single total order of operations across all threads, which is exactly what we need for the publish + recheck pattern to be airtight.

NOTE: *This is a great spot to call out something interesting about lock-free programming, we deliberately do not reach for `seq_cst` everywhere. Default sequential consistency is the safest and the slowest, every `seq_cst` operation acts as a global synchronization point that prevents the compiler and CPU from reordering loads and stores around it. `acquire` and `release` are pairwise instead, an acquire load is synchronized only with a release store on the same variable, which is much cheaper. `relaxed` provides atomicity but no ordering guarantees at all. Throughout the queue you will see all four orderings used in different spots, slot commit uses `release` because we want all earlier writes to be visible to a consumer that acquires the flag, hazard pointer publish uses `seq_cst` because the publish-then-recheck pattern fundamentally needs a global total order, and the initial `head.store` and `tail.store` in the queue constructor use `relaxed` because nothing else has started yet. Each ordering is picked individually, which can shave significant cycles off the hot path, especially on weakly ordered architectures like ARM where `seq_cst` is genuinely expensive.*

The `Scan` function is the deletion logic. It is invoked only when a thread has accumulated `RetireThreshold` retired pointers, which is set by default to `2 * ThreadCount * PointerCount` (the maximum possible number of simultaneously hazarded pointers). The function gathers every currently published hazard pointer from every thread into the scratch buffer, sorts it once, and then walks the retired list, using binary search to check whether each retired pointer is still hazarded. If not, the pointer is safe to delete and we hand it to the deleter. If it is still hazarded, we keep it on the retired list for next time. The trick of `swap with the back, then pop` is a constant time vector erase, which avoids the quadratic blowup of erasing from the middle.

NOTE: *There are two easy-to-miss performance tricks hiding in this function. First, we never allocate during a scan, the `scratchBuffer` was preallocated by the constructor and we reuse it on every call via `clear()`, which empties the vector without releasing its capacity. Second, the `sort + binary_search` combo turns what would naively be `O(N * R)` work (where `N` is the number of active hazard pointers and `R` is the size of the retired list) into `O((N + R) log N)`. For typical thread counts and pointer counts this often takes a pass that would have been a few microseconds down to a few hundred nanoseconds, which is the difference between the GC being a noticeable spike and being invisible in a profile.*

Something that confused me when I started dealing with Hazard Pointers was the question, that what if multiple threads actaully call retire, as you see in out mechanism there is no way to detect that we would end up calling delete on the same pointer twice, but then I realized that the idea is thats not how you use a hazard pointer. You see you are calling protect with a atomic pointer reference, now when exactly are you suppossed to call retire? Ideally we only call retire once we actually sure that our current thread has taken the ownership of that pointer that is, we were successful in a CAS and now we own the ptr, and the atomic variable is something else. Other threads might still have a local copy of it but no one can take ownership of it now, so we can safely call retire.

```cpp
template <typename Deleter = std::nullptr_t>
  requires(std::invocable<Deleter, T*> ||
           std::same_as<Deleter, std::nullptr_t>)
void Scan(uint32_t threadId, Deleter deleter) {
  auto& activePointersTracker = state[threadId].scratchBuffer;
  activePointersTracker.clear();

  for (const auto& list : state) {
    for (const auto& pointer : list.hazardPointers) {
      T* ptr = pointer.load(std::memory_order::seq_cst);
      if (ptr) activePointersTracker.push_back(ptr);
    }
  }

  std::sort(activePointersTracker.begin(), activePointersTracker.end());

  auto& retiredList = state[threadId].retiredPointers;
  for (uint32_t i = 0; i < retiredList.size();) {
    if (!std::binary_search(activePointersTracker.begin(),
                            activePointersTracker.end(), retiredList[i])) {
      if constexpr (!std::same_as<Deleter, std::nullptr_t>) {
        deleter(retiredList[i]);
      } else {
        delete retiredList[i];
      }
      retiredList[i] = retiredList.back();
      retiredList.pop_back();
    } else {
      i++;
    }
  }
}
```

Now the API is mostly fine, but there is one really nasty footgun lurking. Every `Protect` call must be paired with a `Release` call, otherwise hazard pointer slots leak and the retire system gets clogged with phantom claims that never go away. In a function with multiple early returns, multiple branches, or any exception path, remembering to release at every exit is error prone. So we steal a trick from Go and implement a tiny `Defer` utility that runs a lambda in its destructor when it goes out of scope, plus a `DEFER` macro that generates a unique variable name per invocation using `__LINE__`. This way, every `Protect` is immediately followed by a single `DEFER(hp.Release(...);)` line, and we are guaranteed the release will happen no matter how the function returns.

```cpp
template <typename F>
  requires std::is_invocable_v<F>
class Defer {
 public:
  explicit Defer(F payload) : deferedPayload(payload) {}
  ~Defer() { std::invoke(deferedPayload); }
 private:
  F deferedPayload;
};

#define CONCAT_IMPL(x, y) x##y
#define CONCAT(x, y)      CONCAT_IMPL(x, y)
#define DEFER(...)                                \
  const auto CONCAT(__deferedPayload, __LINE__) = \
      Defer([&]() { __VA_ARGS__ });
```

The `requires std::is_invocable_v<F>` constraint is small but really nice, it gives a clean compile error if you try to defer something that isnt callable. The `CONCAT(__deferedPayload, __LINE__)` trick makes the variable name unique per source line, so you can stack multiple DEFER calls in one function without collisions. With this in hand, the usage pattern is just gorgeous:

```cpp
Node* current = hp.Protect(head, threadId, 0);
DEFER(hp.Release(threadId, 0););
// ... do whatever, return, throw, doesnt matter ...
// release fires automatically on scope exit
```

Combined, the hazard pointers and the DEFER macro give us a memory reclamation story that is safe, fast, lock free, and ergonomic to use from the queue code. Lets actually wire it into the queue now.

## Part IV: Advanced Reclaiming via Thread-Local Caches

So we have safe memory reclamation, the crashes are gone, the ABA problem is gone, and life is good. But we are still hitting the OS heap when nodes get retired, because the default deleter inside `Scan` is just `delete retiredList[i]`. And as we already established, hitting `new` and `delete` from many threads concurrently means hitting whatever lock the global allocator uses internally, which puts us right back into context switch hell when the allocator gets contended. Can we get rid of the heap entirely on the hot path?

The answer is yes, and the trick is a **thread local node cache**. Instead of deleting a retired node, we throw it onto a per thread vector of "free nodes". The next time this thread needs a new node, instead of calling `new Node()`, it first checks its own local cache, and if there is a node available it just resets and reuses it. Because the cache is per thread there is zero contention, no atomics, no locks, no allocator involvement, just a vector push and pop on memory we already own. The OS heap only gets touched when a thread genuinely needs to grow its working set or when the program shuts down, both of which are rare events compared to the per element hot path.

To make this work cleanly, our `Retire` function needs to accept a custom deleter, so the queue can hand the hazard pointer a lambda that recycles into the cache instead of calling `delete`. This is exactly the templated `Deleter` parameter we built into `HazardPointer::Retire` and `Scan` earlier. Now you can see why both ends were generic, the queue passes its own recycling function in, and the hazard pointer just calls whatever you gave it.

The queue side looks like this. The `AcquireNewNode` function checks the thread local cache first and only allocates if the cache is empty. The `ReleaseNewNode` function pushes back into the cache as long as the cache hasnt grown past its limit, and only actually deletes if the cache is full. Both branches are guarded by `if constexpr (ThreadLocalCacheSize > 0)`, which means if you instantiate the queue with `ThreadLocalCacheSize = 0`, the cache code literally does not exist in the compiled binary. Zero runtime cost for a feature you opted out of.

```cpp
Node* AcquireNewNode(uint32_t threadId) {
  if constexpr (ThreadLocalCacheSize > 0) {
    auto& chBuff = tcBuff[threadId];
    if (chBuff->size() > 0) {
      auto item = chBuff->back();
      item->Reset();
      chBuff->pop_back();
      return item;
    }
  }
  return new Node();
}

void ReleaseNewNode(Node* ptr, uint32_t threadId) {
  if constexpr (ThreadLocalCacheSize > 0) {
    auto& chBuff = tcBuff[threadId];
    if (chBuff->size() < ThreadLocalCacheSize) {
      chBuff->push_back(ptr);
      return;
    }
  }
  delete ptr;
}
```

And the place where the hazard pointer hands a retired node back to us, inside `Pop`, now passes a lambda that calls `ReleaseNewNode` instead of letting the hazard pointer call `delete`. Notice how the lambda captures `this` and `threadId`, so each thread routes recycled nodes back to its own cache:

```cpp
if (tail.compare_exchange_strong(currentTail, next,
                                 std::memory_order::seq_cst,
                                 std::memory_order::acquire)) {
  hp.Retire(currentTail, threadId, [this, threadId](Node* node){
    this->ReleaseNewNode(node, threadId);
  });
}
```

Now we can finally see the full queue glued together. Notice how `Push` uses hazard pointer slot 0 to protect `head`, and `Pop` uses slot 1 to protect `tail`. When a producer finds the head block full and there is no next block linked, it grabs a fresh node from the cache (or heap if the cache is empty), and CASes it as the next pointer. When a consumer finds the tail block fully consumed, it advances `tail` to the next node and retires the old one through the recycling lambda.

```cpp
template <typename T, uint32_t NodeBufferSize, uint32_t ThreadCount,
          bool BlockingRead = false, uint32_t ThreadLocalCacheSize = 256>
class FastQueue {
 public:
  using Node = FastQueueNode<T, NodeBufferSize, BlockingRead>;
  using Self = FastQueue<T, NodeBufferSize, ThreadCount, BlockingRead>;

  FORCE_INLINE FastQueue() {
    auto node = new Node();
    head.store(node, std::memory_order::relaxed);
    tail.store(node, std::memory_order::relaxed);

    if constexpr (ThreadLocalCacheSize > 0) {
      for (auto i = 0; i < ThreadCount; i++) {
        tcBuff[i]->reserve(ThreadLocalCacheSize);
      }
    }
  }

  FORCE_INLINE ~FastQueue() {
    auto current = tail.load(std::memory_order::relaxed);
    while (current != nullptr) {
      auto next = current->Next(std::memory_order::relaxed);
      delete current;
      current = next;
    }

    if constexpr (ThreadLocalCacheSize > 0) {
      for (uint32_t i = 0; i < ThreadCount; i++) {
        for (auto node : (ThreadLocalCacheBuffer)tcBuff[i]) {
          delete node;
        }
      }
    }
  }

  FORCE_INLINE void Push(T* value, uint32_t threadId) {
    Node *current = nullptr, *next = nullptr;
    while (true) {
      current = hp.Protect(head, threadId, 0);
      DEFER(hp.Release(threadId, 0););

      if (current->Push(value)) break;

      next = current->Next(std::memory_order::acquire);

      if (next == nullptr) {
        auto newNode = AcquireNewNode(threadId);
        if (!current->TrySetNext(next, newNode)) {
          ReleaseNewNode(newNode, threadId);
        }
        continue;
      }

      head.compare_exchange_strong(current, next, std::memory_order::seq_cst,
                                   std::memory_order::acquire);
    }
  }

  FORCE_INLINE bool Pop(T* value, uint32_t threadId) {
    Node *currentTail = nullptr, *next = nullptr;

    while (true) {
      currentTail = hp.Protect(tail, threadId, 1);
      DEFER(hp.Release(threadId, 1););

      if (currentTail->Pop(value)) return true;
      if (!currentTail->IsUsedUp(std::memory_order::seq_cst)) return false;

      next = currentTail->Next(std::memory_order::acquire);

      if (!next) return false;

      if (tail.compare_exchange_strong(currentTail, next,
                                       std::memory_order::seq_cst,
                                       std::memory_order::acquire)) {
        hp.Retire(currentTail, threadId, [this, threadId](Node* node){
          this->ReleaseNewNode(node, threadId);
        });
      }
    }
  }

 private:
  using ThreadLocalCacheBuffer = std::vector<Node*>;

  alignas(64) std::atomic<Node*> head;
  alignas(64) std::atomic<Node*> tail;
  alignas(64) HazardPointer<Node, ThreadCount, 4, 16> hp;
  alignas(64) std::array<Aligned<ThreadLocalCacheBuffer, 64>,
                    (ThreadLocalCacheSize > 0) ? ThreadCount : 1> tcBuff;
};
```


The full signature is `template <typename T, uint32_t NodeBufferSize, uint32_t ThreadCount, bool BlockingRead = false, uint32_t ThreadLocalCacheSize = 256>`, and every one of those parameters resolves at compile time. `NodeBufferSize` is how many slots live in each node, larger values reduce pointer chasing but increase memory per active node. `ThreadCount` is the maximum number of threads that will ever touch this queue, used to size the hazard pointer arrays. `BlockingRead` toggles whether consumers wait on uncommitted slots using C++20 wait/notify or just return false. And `ThreadLocalCacheSize` controls how many recycled nodes each thread is allowed to hoard before falling back to actually deleting. If you instantiate `FastQueue<int, 1024, 16, false, 0>`, the resulting binary contains no thread local cache logic at all, no blocking branch in the slot commit, no `notify_one` call, no wait loop, all of that code is literally absent. Each configuration is its own queue, optimized for exactly the use case you asked for.

NOTE: *There is also one really subtle but powerful interaction between `ThreadCount` and the hazard pointer system. The retire threshold defaults to `2 * ThreadCount * PointerCount`, which means threads on bigger systems automatically batch their reclamation work more aggressively, keeping the per operation overhead roughly constant regardless of system size.*

## Performance & Benchmarks

Now all our taling would be wasted if we dont have numbers backing it. I wrote a super simple benchmark suite that pushes **5,000,000 items** through each queue under various producer / consumer thread combinations, and measures wall clock time from "all threads ready" to "all items consumed". The three contenders are our `FastQueue` (the final beast we built across the last four sections), the `SimpleQueue` with `std::mutex`, and a `NaiveLockFreeQueue` (the textbook Michael Scott lock free queue with `new`/`delete` per element). All compiled with `-O3 -std=c++20` on `clang++`, on a 16 core Intel desktop CPU with hyperthreading enabled (so up to 32 logical cores available).

| Scenario | SimpleQueue (Mutex) | NaiveLockFree | FastQueue (Ours) | Speedup (Ours vs Mutex) |
|---|---|---|---|---|
| **MPMC Low (2P/2C)** | 250.7 ms | 797.1 ms | 150.8 ms | ~1.6x faster |
| **MPMC Med (8P/8C)** | 2152.2 ms | 2426.5 ms | 309.7 ms | ~6.9x faster |
| **MPMC High (16P/16C)** | 2600.7 ms | 2413.5 ms | 299.6 ms | **~8.6x faster** |
| **SPMC Med (1P/8C)** | 3138.0 ms | 1595.1 ms | 253.9 ms | **~12.3x faster** |
| **MPSC Med (8P/1C)** | 563.2 ms | 1865.2 ms | 252.2 ms | ~2.2x faster |

Lets walk through what these numbers mean, because the analysis is where the real lesson lives. At 2 producers and 2 consumers (the low contention case), the mutex queue is only mildly slower than the FastQueue, around 1.6x. This is the case where you should just use a mutex, the complexity of all the lock free machinery we built is overkill if you only have a handful of threads gently exchanging data. Notice also that the naive lock free queue is *already slower* than the mutex at this contention level, which is a perfect demonstration of how `new`/`delete` per element kills throughput. Allocator contention starts hurting before lock contention does.

Now look at the 16 producers and 16 consumers row. The mutex queue absolutely collapses, jumping from 250 ms at 2/2 to 2600 ms at 16/16, more than 10x slower while the workload only increased linearly. This is the OS scheduler death spiral, every contended lock acquisition is a context switch, and with 32 threads all hammering the same mutex you are spending the vast majority of CPU time in the kernel just shuffling threads. Meanwhile our FastQueue goes from 150 ms to 299 ms, almost exactly the scaling you would expect from doubling the workload, and finishes the same job in less than 12% of the time. That ~8.6x speedup at high contention is the entire point of building a lock free queue. The mutex isnt slower because it is broken, it is slower because it fundamentally cant scale past the point where the kernel starts mediating every operation.

The next result is the SPMC case, one producer and eight consumers. The mutex queue takes 3.1 seconds because eight consumers are constantly fighting over the same mutex, and the producer also has to acquire it to insert. The naive lock free queue is faster (1.6 seconds) but still pays for allocator contention. Our FastQueue rips through the same workload in 254 ms, a **12.3x speedup** over the mutex baseline. This is exactly the pattern you see in task scheduling systems, one boss thread distributing work to a pool of workers. If you build that with a mutex queue, your worker threads will spend most of their time blocked on the lock instead of doing work. With a proper lock free queue, the workers stay busy and the throughput scales nearly linearly with the worker count.

The MPSC case (8 producers, 1 consumer) is interesting because the mutex queue actually does pretty well, 563 ms, only 2.2x slower than FastQueue. The reason is that there is only one consumer, so consumer-side contention is zero, and the producers are mostly fighting amongst themselves. The mutex is fundamentally a fair lock so producers take turns, and the consumer just drains continuously. This is the closest the mutex gets to looking respectable, which is honestly a useful data point, mutex queues are not universally bad, they just stop scaling once you have multiple consumers fighting over them. The naive lock free queue does poorly here (1865 ms) because every producer still hits the allocator on every push, so allocator contention dominates.

If you want to try running these benchmarks youseld, the entire benchmark code is below.
You can get the header from : [here](https://gist.github.com/Jaysmito101/11a85e67732b9a9177b4270c60195ae9)

```cpp
#include <iostream>
#include <thread>
#include <vector>
#include <chrono>
#include <atomic>
#include <string>
#include "fast_lockfree_queue.hpp"

constexpr int NUM_ITEMS = 5'000'000;

template <typename Q>
double run_benchmark(int num_producers, int num_consumers) {
    Q queue;
    std::atomic<int> start_flag{0};
    std::atomic<int> items_consumed{0};

    auto producer = [&](int tid, int items_to_push) {
        while (start_flag.load(std::memory_order::acquire) == 0) {}
        for (int i = 0; i < items_to_push; ++i) {
            int val = i + tid * items_to_push;
            queue.Push(&val, tid);
        }
    };

    auto consumer = [&](int tid, int total_to_consume) {
        while (start_flag.load(std::memory_order::acquire) == 0) {}
        int val = 0;
        while (items_consumed.load(std::memory_order::relaxed) < total_to_consume) {
            if (queue.Pop(&val, tid)) {
                items_consumed.fetch_add(1, std::memory_order::relaxed);
            }
        }
    };

    std::vector<std::thread> threads;
    threads.reserve(num_producers + num_consumers);

    const int items_per_producer = NUM_ITEMS / std::max(1, num_producers);

    for (int i = 0; i < num_producers; ++i) {
        threads.emplace_back(producer, i, items_per_producer);
    }
    for (int i = 0; i < num_consumers; ++i) {
        threads.emplace_back(consumer, num_producers + i, NUM_ITEMS);
    }

    auto start_time = std::chrono::high_resolution_clock::now();
    start_flag.store(1, std::memory_order::release);
    for (auto& t : threads) t.join();
    auto end_time = std::chrono::high_resolution_clock::now();

    return std::chrono::duration<double, std::milli>(end_time - start_time).count();
}

template <typename Q>
void run_scenario(const std::string& label, int p, int c) {
    double ms = run_benchmark<Q>(p, c);
    std::cout << label << " (" << p << "P/" << c << "C): "
              << ms << " ms\n";
}

int main() {
    using Fast   = FastQueue<int, 1024, 32, false, 256>;
    using Simple = SimpleQueue<int>;

    std::cout << "==== FastQueue ====\n";
    run_scenario<Fast>("FastQueue", 2, 2);
    run_scenario<Fast>("FastQueue", 8, 8);
    run_scenario<Fast>("FastQueue", 16, 16);
    run_scenario<Fast>("FastQueue", 1, 8);
    run_scenario<Fast>("FastQueue", 8, 1);

    std::cout << "==== SimpleQueue ====\n";
    run_scenario<Simple>("SimpleQueue", 2, 2);
    run_scenario<Simple>("SimpleQueue", 8, 8);
    run_scenario<Simple>("SimpleQueue", 16, 16);
    run_scenario<Simple>("SimpleQueue", 1, 8);
    run_scenario<Simple>("SimpleQueue", 8, 1);

    return 0;
}
```

Hope you enjoyed reading this as much as I did making this!
