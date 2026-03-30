---
title: "Work, Projects and Publications"
description: "My experience, notable projects, and research publications."
updatedDate: "2026-03-31"
---

## Profile

I build high performance systems close to the hardware, with a focus on graphics, image processing, multimedia pipelines, and low-level optimization. My work combines systems programming, custom 2D/3D rendering engines, and production grade tooling.

## Notable Projects

### [Advanced Vulkan Demos (AVD)](https://github.com/Jaysmito101/AdvancedVulkanDemos)

Advanced Vulkan Demos is a Vulkan 1.4 rendering engine I built from scratch to explore modern real-time rendering features such as subsurface scattering, HDR bloom, radiance cascades, and PBR skin shading. The project includes a custom deferred pipeline with G-Buffer workflows, build-time asset processing, and deeper experiments around GPU-driven rendering and video decode systems. The goal is to mainly explore advanced concepts in Vulkan, GPU architecture, and real-time graphics techniques, while also serving as a practical reference for engine design and optimization for me in the future.

### [TerraForge3D](https://github.com/Jaysmito101/TerraForge3D)

TerraForge3D is an advanced procedural terrain generation platform with GPU-first architecture, combining OpenCL and GLSL compute workflows with high-volume terrain synthesis algorithms. It uses a multithreaded execution model with lock-free queues and work-stealing, and is optimized for massive heightmap generation through tiled processing, memory streaming, and SIMD-accelerated hybrid CPU/GPU computation.

### [rusty.hpp](https://github.com/Jaysmito101/rusty.hpp)

rusty.hpp is a header-only C++20 library that introduces Rust-inspired ownership and borrow-checking ideas into C++ with low overhead. It provides practical memory-safety oriented patterns, including lifetime validation and strongly expressive utility abstractions such as `Option<T>` and `Result<T, E>`. As well as it includes a dyn Traits like system from Rust built with type erasure without vtable overheads, using modern C++ features.

### [XLUX](https://github.com/Jaysmito101/Xlux)

XLUX is a software rasterization engine that reconstructs core GPU pipeline behavior in software, including programmable vertex/fragment stages, perspective-correct interpolation, depth buffering, and tile-based rasterization. Its performance comes from algorithmic optimization, SIMD vectorization, and parallel triangle binning across CPU threads.

### [cgl](https://github.com/Jaysmito101/cgl)

cgl is a zero-dependency C graphics and math library focused on low-level control, offering OpenGL-oriented GPU abstractions, cross-platform window/input handling, and optimized linear algebra primitives. It also includes practical spatial systems such as Octree and KD-Tree structures for ray queries, collision tasks, pathfinding, and post-processing pipelines.

## Research Publications

My publications include **Efficient Partitioning of a Multi-dimensional Axis-Aligned Space** (DoSIER 2023, in Recent Trends in Intelligence Enabled Research, Advances in Intelligent Systems and Computing) and **A Detailed Comparative Study of Regression Models for Stock Price Prediction** (CIBA 2024, 6th International Conference on Computational Intelligence in Communications and Business Analytics).
