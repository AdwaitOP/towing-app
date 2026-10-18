import React, { useState, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Truck } from 'lucide-react';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';

export const AdminLayout: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuOpenerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar
        onMobileMenuToggle={() => setMobileMenuOpen(true)}
        mobileMenuOpenerRef={mobileMenuOpenerRef}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Desktop Sidebar (persistent on md and above) */}
        <div className="hidden md:block">
          <Sidebar />
        </div>

        {/* Mobile Sidebar Drawer (using Radix Dialog for accessibility, focus trap & Escape support) */}
        <Dialog.Root open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
            <Dialog.Content
              className="fixed inset-y-0 left-0 z-50 w-72 bg-slate-900 border-r border-slate-800 p-4 shadow-2xl flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left duration-200"
              aria-describedby="mobile-nav-description"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                mobileMenuOpenerRef.current?.focus();
              }}
            >
              <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-orange-600 rounded-lg text-white">
                    <Truck className="h-4 w-4" />
                  </div>
                  <Dialog.Title className="font-bold text-sm text-white">TowMitra Operations</Dialog.Title>
                </div>
                <Dialog.Close asChild>
                  <button
                    className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-500"
                    aria-label="Close navigation menu"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </div>

              <p id="mobile-nav-description" className="sr-only">
                Navigation drawer for TowMitra Admin Console
              </p>

              <div className="flex-1 overflow-y-auto">
                <Sidebar onItemClick={() => setMobileMenuOpen(false)} />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-slate-950 p-4 sm:p-6 lg:p-8">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};
