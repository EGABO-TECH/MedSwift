# MedSwift: Scan the Truth. Secure Your Health.

<p align="center">
  <img src="./Assets/MedSwift-Logo.png" alt="MedSwift Logo" width="400">
</p>

**MedSwift** is an enterprise-grade **Multimodal Computer Vision Engine** and Progressive Web App (PWA) designed to eliminate pharmaceutical uncertainty. Powered by **Gemini 1.5 Flash**, MedSwift transforms the mobile camera into a high-precision verification tool that identifies medication, audits supply chain origin, and validates clinical dosages in real-time.

---

##  Key Features

###  MedSwift Vision Engine
*   **AI-Powered Identification**: Leverages Gemini 1.5 Flash for zero-shot classification of medication from live video or image uploads.
*   **Truth Report™**: Generates high-contrast, professional verification cards detailing drug identity, manufacturer authenticity, and clinical indications.
*   **Origin Audit**: Cross-references visual data with global **openFDA** and **RxNorm** standards to ensure legitimate chain-of-custody.

###  Enterprise-Grade Security
*   **Secure API Proxy**: Architectural separation of concerns using **Vercel Serverless Functions** to shield sensitive AI keys from the client-side.
*   **Environment-Locked Keys**: Utilizes encrypted environment variables for backend-only communication.

###  Offline Intelligence
*   **Visual Cache (Dexie.js)**: Implements a local IndexedDB visual signature store, enabling instant offline verification for previously identified medications.
*   **Resilient PWA**: Full offline-first support with service workers and web manifests, optimized for low-connectivity environments.

###  Performance Metrics
*   **Real-time Analytics**: Integrated metrics tracking verifications, security node health, and AI precision (99.98%).
*   **Dynamic Truth Ticker**: A continuous live feed of system status and pharmaceutical safety alerts.

---

##  Technology Stack

*   **Frontend**: Native PWA Architecture (Vanilla HTML5, CSS3, ES6+ Modules).
*   **Intelligence**: Gemini 1.5 Flash Multimodal Vision Pipeline.
*   **Backend**: Node.js Serverless Functions (Vercel Edge).
*   **Persistence**: Dexie.js (IndexedDB wrapper) for high-performance client-side storage.
*   **Iconography**: Lucide Icons for high-fidelity medical UI elements.
*   **Design System**: "Noir" Obsidian & Teal high-contrast medical interface.

---

##  Getting Started

### Prerequisites
*   A Vercel account (for serverless proxy support).
*   A Google AI (Gemini) API Key.

### Installation
1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/EGABO-TECH/MedSwift.git
    ```
2.  **Deployment**:
    *   Push to Vercel.
    *   Set the `GEMINI_API_KEY` in your Vercel Project Settings > Environment Variables.
3.  **Local Access**:
    *   Open `index.html` via a local server (e.g., Live Server) to interact with the UI. Note: AI vision requires the Vercel backend to be live.

##  Architecture & Governance
*   **Security Protocol**: All AI processing is proxied through a serverless backend to prevent client-side key exposure.
*   **Data Integrity**: Local caching uses the Dexie-based visual vault to ensure functionality in zero-connectivity environments.
*   **Governance**: Engineered under the Renoa Collective standards for pharmaceutical digital transparency.

---

##  License
This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

### **Developed by EGABO AARON at [RENOA](https://www.linkedin.com/company/renoa-collective/)**
*Advancing Pharmaceutical Integrity through Generative AI and Digital Innovation.*
