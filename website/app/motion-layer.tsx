"use client";

import { useEffect } from "react";

export function MotionLayer() {
  useEffect(() => {
    const root = document.documentElement;
    let mouseFrame = 0;
    let scrollFrame = 0;

    const handlePointer = (event: PointerEvent) => {
      cancelAnimationFrame(mouseFrame);
      mouseFrame = requestAnimationFrame(() => {
        root.style.setProperty("--mouse-x", `${event.clientX}px`);
        root.style.setProperty("--mouse-y", `${event.clientY}px`);
      });
    };

    const handleScroll = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const progress = max > 0 ? window.scrollY / max : 0;
        root.style.setProperty("--scroll-progress", `${progress}`);
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 },
    );

    document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
    window.addEventListener("pointermove", handlePointer, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => {
      observer.disconnect();
      window.removeEventListener("pointermove", handlePointer);
      window.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(mouseFrame);
      cancelAnimationFrame(scrollFrame);
    };
  }, []);

  return null;
}
