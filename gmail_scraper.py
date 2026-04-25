import os
import re
import base64
import logging
import sqlite3
from bs4 import BeautifulSoup
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
DATABASE_PATH = os.path.join(os.path.dirname(__file__), 'data', 'ir.db')

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ============================================================
# AUTH
# ============================================================
def authenticate_gmail():
    """Authenticates the user and returns the Gmail service object."""
    creds = None
    token_path = os.path.join(os.path.dirname(__file__), 'token.json')
    credentials_path = os.path.join(os.path.dirname(__file__), 'credentials.json')

    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)
    
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(credentials_path):
                raise FileNotFoundError(
                    f"Required file '{credentials_path}' not found.\n"
                    "Please get this file from Google Cloud Console."
                )
            flow = InstalledAppFlow.from_client_secrets_file(credentials_path, SCOPES)
            creds = flow.run_local_server(port=0)
        
        with open(token_path, 'w') as token:
            token.write(creds.to_json())
            
    return build('gmail', 'v1', credentials=creds)

# ============================================================
# EMAIL PARSING
# ============================================================
def parse_irctc_email(text):
    """
    Parses the text content of an IRCTC booking confirmation email.
    
    The email body (after HTML→text via BeautifulSoup with separator='|')
    contains fields like:
        PNR No. : | 4435250125 | Train No. / Name : | 12026 / PUNE SHATABDI
        From : | HYDERABAD DECAN (HYB) | Date of Journey : | 22-Mar-2026
        To : | PUNE JN (PUNE)
    """
    journey = {}
    
    # Normalize: collapse whitespace, keep pipe separators
    clean = re.sub(r'\s+', ' ', text)

    # PNR — 10 digits
    m = re.search(r'PNR No\.?\s*:?\s*\|?\s*(\d{10})', clean, re.IGNORECASE)
    if m:
        journey['pnr'] = m.group(1)
    
    # Train Number — digits before "/"
    m = re.search(r'Train No\.?\s*/\s*Name\s*:?\s*\|?\s*(\d{4,5})\s*/\s*(.+?)(?:\|)', clean, re.IGNORECASE)
    if m:
        journey['train_number'] = m.group(1).strip()
        journey['train_name'] = m.group(2).strip()
    
    # From — station name with code in parentheses
    m = re.search(r'From\s*:?\s*\|?\s*([^|]*?\(([A-Z]{2,5})\))', clean, re.IGNORECASE)
    if m:
        journey['origin'] = m.group(2).upper()
        journey['origin_name'] = m.group(1).strip()
    
    # To — station name with code in parentheses
    m = re.search(r'(?<!\bReservation Up )\bTo\s*:?\s*\|?\s*([^|]*?\(([A-Z]{2,5})\))', clean, re.IGNORECASE)
    if m:
        journey['destination'] = m.group(2).upper()
        journey['destination_name'] = m.group(1).strip()
    
    # Date of Journey
    m = re.search(r'Date of Journey\s*:?\s*\|?\s*([\d]{1,2}-[A-Za-z]{3}-[\d]{4})', clean, re.IGNORECASE)
    if m:
        journey['journey_date'] = m.group(1)

    # Class
    m = re.search(r'Class\s*:?\s*\|?\s*([A-Z][A-Z ]+?)(?:\s*\|)', clean, re.IGNORECASE)
    if m:
        journey['travel_class'] = m.group(1).strip()

    # Validate minimum required fields
    required = ['pnr', 'train_number', 'origin', 'destination']
    if all(k in journey for k in required):
        return journey
    
    logging.warning(f"Incomplete parse. Got: {list(journey.keys())}, missing: {[k for k in required if k not in journey]}")
    return None


def parse_subject_line(subject):
    """
    Fallback parser from the subject line itself.
    Subject format: "Booking Confirmation on IRCTC, Train: 12026, 22-Mar-2026, CC, HYB - PUNE"
    """
    m = re.search(
        r'Booking Confirmation on IRCTC,\s*Train:\s*(\d+),\s*(\d{1,2}-[A-Za-z]{3}-\d{4}),\s*([A-Z0-9]+),\s*([A-Z]+)\s*-\s*([A-Z]+)',
        subject, re.IGNORECASE
    )
    if m:
        return {
            'train_number': m.group(1),
            'journey_date': m.group(2),
            'travel_class': m.group(3),
            'origin': m.group(4).upper(),
            'destination': m.group(5).upper()
        }
    return None

# ============================================================
# GMAIL FETCH
# ============================================================
def fetch_irctc_tickets(max_results=200):
    """Fetches IRCTC booking confirmation emails and parses them."""
    service = authenticate_gmail()
    
    # Correct query: match actual subject format
    query = 'from:ticketadmin@irctc.co.in subject:"Booking Confirmation"'
    logging.info(f"Querying Gmail: {query}")
    
    all_messages = []
    page_token = None
    
    while True:
        results = service.users().messages().list(
            userId='me', q=query, maxResults=min(max_results - len(all_messages), 100),
            pageToken=page_token
        ).execute()
        
        msgs = results.get('messages', [])
        all_messages.extend(msgs)
        
        page_token = results.get('nextPageToken')
        if not page_token or len(all_messages) >= max_results:
            break
    
    if not all_messages:
        logging.info("No booking confirmation emails found.")
        return []
    
    logging.info(f"Found {len(all_messages)} booking confirmation emails. Parsing...")
    journeys = []
    seen_pnrs = set()
    
    for i, msg_meta in enumerate(all_messages):
        msg = service.users().messages().get(userId='me', id=msg_meta['id'], format='full').execute()
        
        # Get subject line for fallback
        headers = {h['name']: h['value'] for h in msg.get('payload', {}).get('headers', [])}
        subject = headers.get('Subject', '')
        
        # Try body parsing first
        payload = msg.get('payload', {})
        parts = payload.get('parts', [])
        body_data = ""
        
        if not parts:
            body_data = payload.get('body', {}).get('data', '')
        else:
            # Prefer HTML for structured parsing
            for part in parts:
                mime_type = part.get('mimeType', '')
                if mime_type == 'text/html':
                    body_data = part.get('body', {}).get('data', '')
                    break
            if not body_data:
                for part in parts:
                    if part.get('mimeType', '') == 'text/plain':
                        body_data = part.get('body', {}).get('data', '')
                        break
        
        journey = None
        if body_data:
            decoded = base64.urlsafe_b64decode(body_data).decode('utf-8', errors='replace')
            soup = BeautifulSoup(decoded, 'html.parser')
            text = soup.get_text(separator=' | ')
            journey = parse_irctc_email(text)
        
        # Fallback: parse from subject line
        if not journey and subject:
            subj_data = parse_subject_line(subject)
            if subj_data:
                # Use PNR from subject if available, else generate one
                pnr_match = re.search(r'(\d{10})', subject)
                subj_data['pnr'] = pnr_match.group(1) if pnr_match else f"SUBJ_{i}"
                journey = subj_data
        
        if journey:
            pnr = journey.get('pnr', '')
            if pnr not in seen_pnrs:
                seen_pnrs.add(pnr)
                journeys.append(journey)
                logging.info(f"[{i+1}/{len(all_messages)}] PNR {pnr}: Train {journey['train_number']} "
                           f"{journey['origin']} → {journey['destination']} on {journey.get('journey_date', '?')}")
        else:
            logging.warning(f"[{i+1}/{len(all_messages)}] Could not parse email: {subject[:60]}")
    
    return journeys

# ============================================================
# DATABASE
# ============================================================
def init_journeys_table():
    """Creates the Journeys table if it doesn't exist."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS Journeys (
            pnr TEXT PRIMARY KEY,
            train_number TEXT,
            train_name TEXT,
            origin TEXT,
            destination TEXT,
            journey_date TEXT,
            travel_class TEXT,
            origin_name TEXT,
            destination_name TEXT
        )
    ''')
    conn.commit()
    conn.close()
    logging.info("Journeys table ready.")

def save_journeys(journeys):
    """Saves parsed journeys to the database, skipping duplicates."""
    if not journeys:
        return 0
    conn = sqlite3.connect(DATABASE_PATH)
    inserted = 0
    for j in journeys:
        try:
            conn.execute('''
                INSERT OR IGNORE INTO Journeys (pnr, train_number, train_name, origin, destination,
                                                journey_date, travel_class, origin_name, destination_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                j.get('pnr'), j.get('train_number'), j.get('train_name', ''),
                j.get('origin'), j.get('destination'), j.get('journey_date', ''),
                j.get('travel_class', ''), j.get('origin_name', ''), j.get('destination_name', '')
            ))
            if conn.total_changes:
                inserted += 1
        except sqlite3.Error as e:
            logging.error(f"DB error for PNR {j.get('pnr')}: {e}")
    conn.commit()
    conn.close()
    return inserted

def get_all_journeys():
    """Returns all saved journeys from the database."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute('SELECT * FROM Journeys ORDER BY journey_date DESC').fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ============================================================
# MAIN (test mode)
# ============================================================
if __name__ == "__main__":
    print("=" * 60)
    print("  IRCTC Gmail Ticket Scraper")
    print("=" * 60)
    
    init_journeys_table()
    
    journeys = fetch_irctc_tickets(max_results=200)
    print(f"\nParsed {len(journeys)} unique tickets!")
    
    if journeys:
        saved = save_journeys(journeys)
        print(f"Saved {saved} new journeys to database.")
        
        print(f"\n{'PNR':<12} {'Train':<8} {'Route':<20} {'Date':<15} {'Class'}")
        print("-" * 70)
        for j in journeys:
            route = f"{j.get('origin','?')} → {j.get('destination','?')}"
            print(f"{j.get('pnr','?'):<12} {j.get('train_number','?'):<8} {route:<20} {j.get('journey_date','?'):<15} {j.get('travel_class','?')}")
