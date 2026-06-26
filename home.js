const themeToggle = document.getElementById("themeToggle");

themeToggle.addEventListener("click", () => {
  document.body.classList.toggle("light");

  if (document.body.classList.contains("light")) {
    themeToggle.textContent = "☀️";
  } else {
    themeToggle.textContent = "🌙";
  }
});

const revealElements = document.querySelectorAll(".reveal");

const revealObserver = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("active");
      }
    });
  },
  {
    threshold: 0.15
  }
);

revealElements.forEach(element => {
  revealObserver.observe(element);
});

const counters = document.querySelectorAll("[data-count]");
let counterStarted = false;

function startCounters() {
  if (counterStarted) return;

  const statsSection = document.querySelector(".hero-stats");
  const sectionTop = statsSection.getBoundingClientRect().top;

  if (sectionTop < window.innerHeight) {
    counterStarted = true;

    counters.forEach(counter => {
      const target = Number(counter.dataset.count);
      let current = 0;
      const speed = Math.max(1, Math.floor(target / 60));

      const updateCounter = () => {
        current += speed;

        if (current >= target) {
          counter.textContent = target;
        } else {
          counter.textContent = current;
          requestAnimationFrame(updateCounter);
        }
      };

      updateCounter();
    });
  }
}

window.addEventListener("scroll", startCounters);
window.addEventListener("load", startCounters);

const canvas = document.getElementById("particleCanvas");
const ctx = canvas.getContext("2d");

let particles = [];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  createParticles();
}

function createParticles() {
  particles = [];

  const particleCount = Math.floor(window.innerWidth / 22);

  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      radius: Math.random() * 2 + 0.8,
      speedX: (Math.random() - 0.5) * 0.35,
      speedY: (Math.random() - 0.5) * 0.35
    });
  }
}

function drawParticles() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  particles.forEach((particle, index) => {
    particle.x += particle.speedX;
    particle.y += particle.speedY;

    if (particle.x < 0 || particle.x > canvas.width) {
      particle.speedX *= -1;
    }

    if (particle.y < 0 || particle.y > canvas.height) {
      particle.speedY *= -1;
    }

    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6, 182, 212, 0.55)";
    ctx.fill();

    for (let j = index + 1; j < particles.length; j++) {
      const other = particles[j];
      const distanceX = particle.x - other.x;
      const distanceY = particle.y - other.y;
      const distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY);

      if (distance < 120) {
        ctx.beginPath();
        ctx.moveTo(particle.x, particle.y);
        ctx.lineTo(other.x, other.y);
        ctx.strokeStyle = `rgba(139, 92, 246, ${1 - distance / 120})`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }
  });

  requestAnimationFrame(drawParticles);
}

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
drawParticles();

const portalButtons = document.querySelectorAll(".portal-btn");

portalButtons.forEach(button => {
  button.addEventListener("mousemove", event => {
    const rect = button.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    button.style.background = `
      radial-gradient(circle at ${x}px ${y}px, rgba(255,255,255,0.35), transparent 18%),
      linear-gradient(135deg, var(--primary), var(--secondary))
    `;
  });

  button.addEventListener("mouseleave", () => {
    button.style.background = "linear-gradient(135deg, var(--primary), var(--secondary))";
  });
});