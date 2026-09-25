import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  PLATFORM_ID,
  computed,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  Auth,
  Unsubscribe as AuthUnsubscribe,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
  query,
  doc,
  updateDoc,
  deleteDoc,
  Firestore,
  Unsubscribe as FirestoreUnsubscribe,
} from 'firebase/firestore';

export interface Monster {
  id: string;
  name: string;
  category: string;
  mediaUrl?: string;
  description: string;
  createdAt?: { toMillis?: () => number; seconds?: number; nanoseconds?: number } | null;
  addedBy?: string;
}

const firebaseConfig = {
  apiKey: 'AIzaSyDmKsRuYp-Y_iZyLt6bwyYcqClwIMMo2Qo',
  authDomain: 'szornykodex-f0999.firebaseapp.com',
  projectId: 'szornykodex-f0999',
  storageBucket: 'szornykodex-f0999.firebasestorage.app',
  messagingSenderId: '1064930466880',
  appId: '1:1064930466880:web:78b30f5ca0e5afa1f9d3a5',
};

const COLLECTION_NAME = 'monsters';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [ReactiveFormsModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly sanitizer = inject(DomSanitizer);

  // State Signals
  readonly currentYear = new Date().getFullYear();
  readonly isLoading = signal<boolean>(true);
  readonly currentView = signal<'public' | 'login' | 'admin'>('public');
  readonly currentUserId = signal<string | null>(null);
  readonly monsters = signal<Monster[]>([]);
  readonly editingMonsterId = signal<string | null>(null);

  // Notifications
  readonly loginError = signal<string | null>(null);
  readonly isLoggingIn = signal<boolean>(false);
  readonly isSavingMonster = signal<boolean>(false);
  readonly adminMessage = signal<{ text: string; isError: boolean } | null>(null);

  // Search & Filter
  readonly searchFilter = signal<string>('');
  readonly selectedCategory = signal<string>('');

  // Image Modal
  readonly expandedImage = signal<{ url: string; title: string } | null>(null);

  // Delete Confirmation Modal
  readonly monsterToDelete = signal<Monster | null>(null);
  readonly isDeleting = signal<boolean>(false);

  // Forms
  readonly loginForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  readonly monsterForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    category: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    mediaUrl: new FormControl('', { nonNullable: true }),
    description: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  // Cached YouTube Safe URLs
  private readonly sanitizedUrls = new Map<string, SafeResourceUrl>();

  // Firebase instances
  private app: FirebaseApp | null = null;
  private db: Firestore | null = null;
  private auth: Auth | null = null;
  private authUnsubscribe: AuthUnsubscribe | null = null;
  private firestoreUnsubscribe: FirestoreUnsubscribe | null = null;
  private adminMsgTimeout: ReturnType<typeof setTimeout> | null = null;

  // Computed Values
  readonly categories = computed<string[]>(() => {
    const cats = new Set<string>();
    for (const m of this.monsters()) {
      if (m.category && m.category.trim()) {
        cats.add(m.category.trim());
      }
    }
    return Array.from(cats).sort((a, b) => a.localeCompare(b, 'hu'));
  });

  readonly categoryCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const m of this.monsters()) {
      const cat = m.category?.trim();
      if (cat) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    return counts;
  });

  readonly filteredMonsters = computed<Monster[]>(() => {
    const term = this.searchFilter().toLowerCase().trim();
    const cat = this.selectedCategory().trim();

    return this.monsters().filter((monster) => {
      const matchesSearch =
        !term ||
        (monster.name && monster.name.toLowerCase().includes(term)) ||
        (monster.description && monster.description.toLowerCase().includes(term)) ||
        (monster.category && monster.category.toLowerCase().includes(term));

      const matchesCategory = !cat || monster.category === cat;
      return matchesSearch && matchesCategory;
    });
  });

  readonly isEditing = computed<boolean>(() => this.editingMonsterId() !== null);

  // Form media preview type computed from current form value
  readonly formMediaPreview = computed(() => {
    const url = this.monsterForm.controls.mediaUrl.value?.trim();
    if (!url) return null;
    const ytId = this.getYoutubeId(url);
    if (ytId) {
      return { type: 'youtube' as const, ytId, safeUrl: this.getSafeYoutubeUrl(ytId) };
    }
    if (this.isVideoUrl(url)) {
      return { type: 'video' as const, url };
    }
    return { type: 'image' as const, url };
  });

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.initFirebase();
      // Safety timeout: ensure loading state never hangs if Firebase takes too long or network is slow
      setTimeout(() => {
        if (this.isLoading()) {
          this.isLoading.set(false);
        }
      }, 3500);
    } else {
      this.isLoading.set(false);
    }
  }

  ngOnDestroy(): void {
    if (this.authUnsubscribe) this.authUnsubscribe();
    if (this.firestoreUnsubscribe) this.firestoreUnsubscribe();
    if (this.adminMsgTimeout) clearTimeout(this.adminMsgTimeout);
  }

  private initFirebase(): void {
    try {
      this.isLoading.set(true);
      const apps = getApps();
      this.app = apps.length > 0 ? apps[0] : initializeApp(firebaseConfig);
      this.db = getFirestore(this.app);
      this.auth = getAuth(this.app);

      this.authUnsubscribe = onAuthStateChanged(this.auth, (user) => {
        if (user) {
          this.currentUserId.set(user.uid);
          if (this.currentView() === 'login') {
            this.currentView.set('admin');
          }
        } else {
          this.currentUserId.set(null);
          if (this.currentView() === 'admin') {
            this.showPublicView();
          }
        }
      });

      this.fetchMonsters();
    } catch (err) {
      console.error('Firebase initializálási hiba:', err);
      this.isLoading.set(false);
    }
  }

  private fetchMonsters(): void {
    if (!this.db) {
      this.isLoading.set(false);
      return;
    }

    try {
      const monstersCol = collection(this.db, COLLECTION_NAME);
      const q = query(monstersCol);

      this.firestoreUnsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const loaded: Monster[] = [];
          snapshot.forEach((d) => {
            const data = d.data();
            loaded.push({
              id: d.id,
              name: data['name'] ?? '',
              category: data['category'] ?? '',
              mediaUrl: data['mediaUrl'] ?? '',
              description: data['description'] ?? '',
              createdAt: data['createdAt'] ?? null,
              addedBy: data['addedBy'] ?? '',
            });
          });

          // Sort by creation time descending (newest first)
          loaded.sort((a, b) => {
            const timeA = this.getMonsterTimestamp(a);
            const timeB = this.getMonsterTimestamp(b);
            return timeB - timeA;
          });

          this.monsters.set(loaded);
          this.isLoading.set(false);
        },
        (err) => {
          console.error('Hiba az adatok lekérésekor:', err);
          this.isLoading.set(false);
        }
      );
    } catch (err) {
      console.error('Adatlekérés inicializálási hiba:', err);
      this.isLoading.set(false);
    }
  }

  private getMonsterTimestamp(m: Monster): number {
    if (!m.createdAt) return 0;
    if (typeof m.createdAt.toMillis === 'function') {
      return m.createdAt.toMillis();
    }
    if (typeof m.createdAt.seconds === 'number') {
      return m.createdAt.seconds * 1000;
    }
    return 0;
  }

  formatDate(m: Monster): string {
    const time = this.getMonsterTimestamp(m);
    if (!time) return 'Mostanában';
    return new Date(time).toLocaleDateString('hu-HU', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  getYoutubeId(url: string | null | undefined): string | null {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[2] && match[2].length === 11 ? match[2] : null;
  }

  getSafeYoutubeUrl(ytId: string): SafeResourceUrl {
    const cached = this.sanitizedUrls.get(ytId);
    if (cached) return cached;
    const safe = this.sanitizer.bypassSecurityTrustResourceUrl(`https://www.youtube.com/embed/${ytId}`);
    this.sanitizedUrls.set(ytId, safe);
    return safe;
  }

  isVideoUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    return !!url.toLowerCase().match(/\.(mp4|webm|ogg)($|\?)/i);
  }

  // Views navigation
  showPublicView(): void {
    this.currentView.set('public');
    if (isPlatformBrowser(this.platformId)) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  toggleAdminPanel(): void {
    if (this.currentUserId()) {
      if (this.currentView() === 'admin') {
        this.showPublicView();
      } else {
        this.cancelEdit();
        this.currentView.set('admin');
        if (isPlatformBrowser(this.platformId)) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    } else {
      if (this.currentView() === 'login') {
        this.showPublicView();
      } else {
        this.loginError.set(null);
        this.currentView.set('login');
        if (isPlatformBrowser(this.platformId)) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    }
  }

  // Admin Auth
  async handleLogin(): Promise<void> {
    if (!this.auth) {
      this.loginError.set('A hitelesítési szolgáltatás nem érhető el.');
      return;
    }
    if (this.loginForm.invalid) {
      this.loginError.set('Kérjük, töltsd ki az e-mailt és a jelszót.');
      return;
    }

    const { email, password } = this.loginForm.getRawValue();
    this.isLoggingIn.set(true);
    this.loginError.set(null);

    try {
      await signInWithEmailAndPassword(this.auth, email, password);
      this.loginForm.reset();
      this.currentView.set('admin');
    } catch (err: unknown) {
      console.error('Belépési hiba:', err);
      this.loginError.set('Hibás e-mail cím vagy jelszó!');
    } finally {
      this.isLoggingIn.set(false);
    }
  }

  async logoutAdmin(): Promise<void> {
    if (!this.auth) return;
    try {
      await signOut(this.auth);
      this.cancelEdit();
      this.showPublicView();
    } catch (err) {
      console.error('Kijelentkezési hiba:', err);
    }
  }

  // Search & Filter handlers
  onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchFilter.set(input.value);
  }

  clearSearch(): void {
    this.searchFilter.set('');
  }

  onCategoryChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedCategory.set(select.value);
  }

  setCategory(category: string): void {
    this.selectedCategory.set(category);
  }

  // Monster Edit / Save
  editMonster(monster: Monster): void {
    this.editingMonsterId.set(monster.id);
    this.monsterForm.setValue({
      name: monster.name || '',
      category: monster.category || '',
      mediaUrl: monster.mediaUrl || '',
      description: monster.description || '',
    });
    this.currentView.set('admin');
    if (isPlatformBrowser(this.platformId)) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  cancelEdit(): void {
    this.editingMonsterId.set(null);
    this.monsterForm.reset({
      name: '',
      category: '',
      mediaUrl: '',
      description: '',
    });
  }

  setCategoryPreset(category: string): void {
    this.monsterForm.controls.category.setValue(category);
  }

  async handleSaveMonster(): Promise<void> {
    const userId = this.currentUserId();
    if (!userId || !this.db) {
      this.showAdminMessage('Nincs jogosultságod vagy az adatbázis nem elérhető!', true);
      return;
    }

    if (this.monsterForm.invalid) {
      this.showAdminMessage('Kérjük töltsd ki az összes kötelező mezőt!', true);
      return;
    }

    this.isSavingMonster.set(true);
    const formVals = this.monsterForm.getRawValue();
    const name = formVals.name.trim();
    const category = formVals.category.trim();
    const mediaUrl = formVals.mediaUrl.trim();
    const description = formVals.description.trim();

    try {
      const editId = this.editingMonsterId();
      if (editId) {
        const monsterDoc = doc(this.db, COLLECTION_NAME, editId);
        await updateDoc(monsterDoc, {
          name,
          category,
          mediaUrl,
          description,
        });
        this.showAdminMessage('Szörny sikeresen frissítve!', false);
      } else {
        const monstersCol = collection(this.db, COLLECTION_NAME);
        await addDoc(monstersCol, {
          name,
          category,
          mediaUrl,
          description,
          createdAt: serverTimestamp(),
          addedBy: userId,
        });
        this.showAdminMessage('Új szörny sikeresen rögzítve a határozóban!', false);
      }

      this.cancelEdit();

      setTimeout(() => {
        this.showPublicView();
      }, 1400);
    } catch (err) {
      console.error('Hiba a mentés során:', err);
      this.showAdminMessage('Hiba történt a mentés során.', true);
    } finally {
      this.isSavingMonster.set(false);
    }
  }

  // Delete Monster
  promptDeleteMonster(monster: Monster): void {
    this.monsterToDelete.set(monster);
  }

  cancelDelete(): void {
    this.monsterToDelete.set(null);
  }

  async confirmDeleteMonster(): Promise<void> {
    const target = this.monsterToDelete();
    if (!target || !this.db) return;

    this.isDeleting.set(true);
    try {
      const docRef = doc(this.db, COLLECTION_NAME, target.id);
      await deleteDoc(docRef);
      this.monsterToDelete.set(null);
    } catch (err) {
      console.error('Hiba a törlésnél:', err);
      alert('Hiba történt a törlés során.');
    } finally {
      this.isDeleting.set(false);
    }
  }

  private showAdminMessage(text: string, isError: boolean): void {
    if (this.adminMsgTimeout) clearTimeout(this.adminMsgTimeout);
    this.adminMessage.set({ text, isError });
    this.adminMsgTimeout = setTimeout(() => {
      this.adminMessage.set(null);
    }, 5000);
  }

  openImageModal(url: string, title: string): void {
    this.expandedImage.set({ url, title });
  }

  closeImageModal(): void {
    this.expandedImage.set(null);
  }

  onImageError(event: Event): void {
    const img = event.target as HTMLImageElement;
    img.src = 'https://placehold.co/600x400/0f172a/34d399?text=Kép+Nem+Elérhető';
  }
}
